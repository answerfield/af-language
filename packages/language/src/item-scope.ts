import {
    AstUtils, DefaultScopeComputation, DefaultScopeProvider, EMPTY_SCOPE, stream,
    type AstNode, type AstNodeDescription, type LangiumDocument, type MultiMap, type ReferenceInfo, type Scope,
    type Stream, type LangiumCoreServices, type URI
} from 'langium';
import type { Cancellation } from 'langium';
type CancellationToken = Cancellation.CancellationToken;
import {
    Component, ElementDecl, EnumDecl, FunctionDecl, Item as ItemType,
    isBinding, isCoding, isCodingRule, isComponent, isFunctionDecl, isContentStatement, isDocument, isElementDecl, isEnumDecl, isHandler,
    isBooklet, isItem, isReference, isValueArgument,
    type Binding, type Coding, type CodingRule, type Item, type Reference
} from './generated/ast.js';
import type { TypeSystem } from './type-system.js';
import { isBuiltinUri } from './builtin/builtins.js';
import type { ItemServices } from './item-module.js';

/** All bindings (named responses) of an item or component, excluding those of nested owners. */
export function bindingsOf(owner: Item | Component): Binding[] {
    return AstUtils.streamAllContents(owner).filter(isBinding).filter(b => ownerOf(b) === owner).toArray();
}

/** Name of the built-in function an expression calls (`correct`, `codes`, `code`, …); otherwise undefined. */
export function builtinCallOf(expr: AstNode | undefined): string | undefined {
    if (!isReference(expr) || !expr.isCall) return undefined;
    const target = expr.target.ref;
    return isFunctionDecl(target) && target.builtin ? target.name : undefined;
}

/** True for a derived score (any expression); false for a coding rule (`correct(…)`, `codes(…)`). */
export function isScoreRule(rule: CodingRule): boolean {
    const fn = builtinCallOf(rule.value);
    return fn !== 'correct' && fn !== 'codes';
}

/** The response a coding rule codes; undefined for a subtask spanning several responses. */
export function ruleAnswer(rule: CodingRule): Binding | undefined {
    if (isScoreRule(rule)) return undefined;
    const item = rule.$container.item.ref;
    return item ? bindingsOf(item).find(b => b.name === rule.name) : undefined;
}

/** Responses whose status matters for a coding rule: the coded response, or all responses its conditions use. */
export function ruleSources(rule: CodingRule): Binding[] {
    const answer = ruleAnswer(rule);
    if (answer) return [answer];
    const used = new Set<Binding>();
    for (const ref of AstUtils.streamAllContents(rule).filter(isReference)) {
        const target = ref.target.ref;
        if (isBinding(target)) used.add(target);
    }
    return [...used];
}

/** Nearest enclosing item or component. */
export function ownerOf(node: AstNode): Item | Component | undefined {
    return AstUtils.getContainerOfType(node.$container, (n): n is Item | Component => isItem(n) || isComponent(n));
}

/** Name of the built-in element a statement calls (`p`, `show`, `part`, …); otherwise undefined. */
export function builtinElementOf(node: AstNode | undefined): string | undefined {
    if (!isContentStatement(node) || !isReference(node.expression)) return undefined;
    const target = node.expression.target.ref;
    return isElementDecl(target) && AstUtils.getDocument(target).uri.scheme === 'af-builtin' ? target.name : undefined;
}

/** The item a booklet statement refers to (`part("…") { aufgabe1 }`); otherwise undefined. */
export function itemRefOf(node: AstNode | undefined): Item | undefined {
    if (!isContentStatement(node) || !isReference(node.expression) || node.expression.isCall) return undefined;
    const target = node.expression.target.ref;
    return isItem(target) ? target : undefined;
}

/** True if the reference is in element position (a call, `p { … }` or `p "…"`). */
export function isElementPosition(ref: Reference): boolean {
    if (ref.isCall) return true;
    const c = ref.$container;
    return isContentStatement(c) && c.expression === ref && (c.hasBody || c.text !== undefined);
}

const CALLABLE_TYPES = new Set<string>([Component.$type, ElementDecl.$type, FunctionDecl.$type]);
/** Declarations that cannot be referenced in expressions (enums only through their members; items only in booklets). */
const NOT_REFERENCEABLE = new Set<string>([EnumDecl.$type, ItemType.$type]);

/** Exports top-level declarations and enum members globally; scopes bindings to their item or component. */
export class ItemScopeComputation extends DefaultScopeComputation {

    constructor(services: LangiumCoreServices) {
        super(services);
    }

    override async collectExportedSymbols(document: LangiumDocument, cancelToken?: CancellationToken): Promise<AstNodeDescription[]> {
        // Top-level declarations and enum members (roles, axes, …) are globally visible.
        return this.collectExportedSymbolsForNode(document.parseResult.value, document,
            root => stream(root.$type === 'Document' ? AstUtils.streamContents(root) : [])
                .flatMap(n => isEnumDecl(n) ? [n, ...n.members] : [n]),
            cancelToken);
    }

    protected override addLocalSymbol(node: AstNode, document: LangiumDocument, symbols: MultiMap<AstNode, AstNodeDescription>): void {
        if (isBinding(node)) {
            // Bindings are visible throughout their item or component, e.g. in `show(when: …)`.
            const owner = ownerOf(node);
            if (owner) {
                symbols.add(owner, this.descriptions.createDescription(node, node.name, document));
            }
            return;
        }
        if (isDocument(node.$container) || isEnumDecl(node.$container)) {
            return; // already exported globally
        }
        if (isCodingRule(node)) {
            return; // subtasks are visible only within their own coding (see codingSymbols)
        }
        super.addLocalSymbol(node, document, symbols);
    }
}

/**
 * Folder distance between two documents: steps up from `from` to the common folder plus steps down to `to`
 * (same folder 0, parent or subfolder 1, sibling folder 2). Built-in libraries are farthest.
 */
export function folderDistance(from: URI, to: URI): number {
    // Paths only: the editor's in-memory preview documents share the folder of their file under another scheme
    if (isBuiltinUri(to) || from.authority !== to.authority) return Number.MAX_SAFE_INTEGER;
    const a = from.path.split('/').slice(0, -1), b = to.path.split('/').slice(0, -1);
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    return a.length - common + (b.length - common);
}

/**
 * Global names, nearest folder first: if several documents declare a name, the one closest to the referencing
 * document wins (e.g. a booklet finds the items of its own import folder, not same-named items of another year).
 */
class NearestScope implements Scope {
    constructor(protected readonly inner: Scope, protected readonly from: URI) { }

    getElement(name: string): AstNodeDescription | undefined {
        return this.getElements(name).head();
    }

    getElements(name: string): Stream<AstNodeDescription> {
        const all = this.inner.getElements(name).toArray();
        if (all.length < 2) return stream(all);
        const distance = new Map(all.map(d => [d, folderDistance(this.from, d.documentUri)]));
        return stream(all.sort((x, y) => distance.get(x)! - distance.get(y)!));
    }

    getAllElements(): Stream<AstNodeDescription> {
        return this.inner.getAllElements();
    }
}

/** Resolves parameters, events, coding symbols and expected enum members; prefers callables in element position. */
export class ItemScopeProvider extends DefaultScopeProvider {
    protected readonly types: () => TypeSystem;

    constructor(services: ItemServices) {
        super(services);
        this.types = () => services.types.TypeSystem;
    }

    override getScope(context: ReferenceInfo): Scope {
        const { container, property } = context;

        if (isValueArgument(container) && property === 'parameter') {
            const callable = isReference(container.$container) ? container.$container.target.ref : undefined;
            return callable && 'parameters' in callable ? this.createScopeForNodes(callable.parameters) : EMPTY_SCOPE;
        }
        if (isHandler(container) && property === 'event') {
            const callable = isReference(container.$container) ? container.$container.target.ref : undefined;
            return isElementDecl(callable) ? this.createScopeForNodes(callable.events) : EMPTY_SCOPE;
        }
        if (isReference(container) && property === 'target') {
            return this.referenceScope(container, context);
        }
        return super.getScope(context);
    }

    protected override getGlobalScope(referenceType: string, context: ReferenceInfo): Scope {
        return new NearestScope(super.getGlobalScope(referenceType, context), AstUtils.getDocument(context.container).uri);
    }

    protected referenceScope(ref: Reference, context: ReferenceInfo): Scope {
        let scope = super.getScope(context);
        const coding = AstUtils.getContainerOfType(ref, isCoding);
        if (coding) {
            scope = this.createScopeForNodes(codingSymbols(coding), scope);
        }
        const expected = this.types().expectedEnum(ref);
        if (expected) {
            scope = this.createScopeForNodes(expected.members, scope);
        }
        const preferCallable = isElementPosition(ref);
        // Items can only be referenced inside a booklet (part("…") { aufgabe1 })
        const inBooklet = AstUtils.getContainerOfType(ref, isBooklet) !== undefined;
        return new PreferringScope(scope, d => CALLABLE_TYPES.has(d.type) === preferCallable,
            d => !NOT_REFERENCEABLE.has(d.type) || (inBooklet && d.type === ItemType.$type));
    }
}

/**
 * Names visible in a coding body: the item's parameters and responses, plus subtasks and scores
 * (rules whose name is not a response).
 */
function codingSymbols(coding: Coding): AstNode[] {
    const item = coding.item.ref;
    const answers = item ? bindingsOf(item) : [];
    const names = new Set(answers.map(b => b.name));
    return [...item?.parameters ?? [], ...answers, ...coding.rules.filter(r => !names.has(r.name))];
}

/**
 * Among entries with the same name, prefers those matching `prefer` (e.g. the element `group` over the role
 * `group` in element position); hides entries failing `include`.
 */
class PreferringScope implements Scope {
    constructor(
        protected readonly inner: Scope,
        protected readonly prefer: (d: AstNodeDescription) => boolean,
        protected readonly include: (d: AstNodeDescription) => boolean
    ) { }

    getElement(name: string): AstNodeDescription | undefined {
        return this.getElements(name).head();
    }

    getElements(name: string): Stream<AstNodeDescription> {
        const all = this.inner.getElements(name).filter(this.include).toArray();
        return stream([...all.filter(this.prefer), ...all.filter(d => !this.prefer(d))]);
    }

    getAllElements(): Stream<AstNodeDescription> {
        return this.inner.getAllElements().filter(this.include);
    }
}

