import { AstUtils, UriUtils, diagnosticData, type AstNode, type ScopeProvider, type FileSystemProvider, type LangiumDocuments, type ValidationAcceptor, type ValidationChecks, type IndexManager } from 'langium';
import {
    isBinding, isBooleanLiteral, isCodingRule, isDocument, isNumberLiteral, isValueArgument, isComponent, isListLiteral, isUnaryExpression, isContentStatement, isElementDecl, isEnumMember, isForStatement,
    isFunctionDecl, isIfExpression, isItem, isLetDecl, isNoneLiteral, isParameter, isReference, isResponseStatement,
    isSetLiteral, isStateDecl, isStringLiteral, isBinaryExpression, isBooklet, isIndexAccess, isRangeExpression,
    Component, Item,
    type Assignment, type Binding, type ChildrenStatement, type Coding, type CodingRule, type ContentStatement,
    type Document, type ElementDecl, type Expression, type ForStatement, type FunctionDecl, type Handler,
    type IfExpression, type IndexAccess, type AfLanguageAstType, type LetDecl, type Reference,
    type StateDecl, type TypeReference, type Booklet, type PointLiteral, type StringLiteral
} from './generated/ast.js';
import type { ItemServices } from './item-module.js';
import { isAssignable, iterableElement, matchArguments, printType, Types, TypeSystem, type Type } from './type-system.js';
import { bindingsOf, builtinCallOf, builtinElementOf, folderDistance, isElementPosition, isScoreRule, itemRefOf, ownerOf, ruleAnswer, ruleSources } from './item-scope.js';
import { isBuiltinUri } from './builtin/builtins.js';
import { mathError } from './math.js';
import { numberedOptions, optionComparison, optionNumber } from './options.js';
import { resolvePlaceholder, templateOf } from './templates.js';


/** Diagnostic codes that quick fixes and tools key on. */
export const IssueCodes = {
    MissingLabel: 'missing-label',
    UnboundResponse: 'unbound-response',
    /** Missing media file: a warning in the editor (the file may be added later), an error for a release */
    MissingMedia: 'missing-media',
    /** point(x, y) where the school notation (x | y) reads better */
    PointNotation: 'point-notation',
    /** Choice compared with option numbers whose texts read better */
    OptionNumbers: 'option-numbers'
} as const;

/** Registers the {@link ItemValidator} checks per AST type. */
export function registerValidationChecks(services: ItemServices): void {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.ItemValidator;
    const checks: ValidationChecks<AfLanguageAstType> = {
        Document: validator.checkDocument,
        Component: [validator.checkComponent, validator.checkUniqueNames],
        Item: [validator.checkItem, validator.checkUniqueNames, validator.checkSchedules],
        ElementDecl: validator.checkBuiltinOnly,
        FunctionDecl: validator.checkFunction,
        TypeReference: validator.checkTypeReference,
        StateDecl: validator.checkState,
        LetDecl: validator.checkLet,
        Binding: validator.checkBinding,
        ContentStatement: [validator.checkContentStatement, validator.checkStatementPlaceholders],
        StringLiteral: validator.checkStringPlaceholders,
        ChildrenStatement: validator.checkChildrenStatement,
        ForStatement: validator.checkFor,
        IfExpression: validator.checkIf,
        BinaryExpression: validator.checkBinary,
        IndexAccess: validator.checkIndex,
        PointLiteral: validator.checkPoint,
        Reference: [validator.checkReference, validator.checkPointNotation],
        Handler: validator.checkHandler,
        Assignment: validator.checkAssignment,
        Coding: validator.checkCoding,
        Booklet: validator.checkBooklet,
        CodingRule: validator.checkCodingRule
    };
    registry.register(checks, validator);
}

/** Nearest enclosing element (looking through for/show); 'component' when a component boundary is reached first. */
function enclosingElement(node: AstNode): { name: string; statement: ContentStatement } | 'component' | undefined {
    for (let c = node.$container; c; c = c.$container) {
        if (isComponent(c)) return 'component';
        if (isItem(c) || isBooklet(c)) return undefined;
        if (isContentStatement(c) && isReference(c.expression) && isElementDecl(c.expression.target.ref)) {
            return { name: c.expression.target.ref.name, statement: c };
        }
    }
    return undefined;
}

/** Semantic checks of the AF language; messages are German product text. */
export class ItemValidator {
    protected readonly types: TypeSystem;
    protected readonly indexManager: IndexManager;
    protected readonly fileSystem: FileSystemProvider;
    protected readonly documents: LangiumDocuments;

    constructor(services: ItemServices) {
        this.documents = services.shared.workspace.LangiumDocuments;
        this.types = services.types.TypeSystem;
        this.indexManager = services.shared.workspace.IndexManager;
        this.fileSystem = services.shared.workspace.FileSystemProvider;
        this.scopes = () => services.references.ScopeProvider;
    }

    protected readonly scopes: () => ScopeProvider;

    // --- Placeholders in texts ----------------------------------------------------

    checkStringPlaceholders(node: StringLiteral, accept: ValidationAcceptor): void {
        this.checkPlaceholders(node, node.value, 'value', accept);
    }

    checkStatementPlaceholders(node: ContentStatement, accept: ValidationAcceptor): void {
        if (node.text !== undefined) this.checkPlaceholders(node, node.text, 'text', accept);
    }

    /** Every placeholder names something visible at the text: a parameter, state, let, loop variable or response. */
    protected checkPlaceholders(node: StringLiteral | ContentStatement, text: string, property: 'value' | 'text', accept: ValidationAcceptor): void {
        for (const part of templateOf(node, text) ?? []) {
            if (typeof part === 'string') continue;
            if (!resolvePlaceholder(this.scopes(), node, part.path[0])) {
                accept('error', `Platzhalter {${part.path.join('.')}}: '${part.path[0]}' ist hier nicht bekannt. Klammern als Text: {{ und }}.`,
                    { node, property: property as never });
            }
        }
    }

    // --- Document and declarations -----------------------------------------------

    checkDocument(document: Document, accept: ValidationAcceptor): void {
        // Top-level names are unique per folder and must not shadow the built-in library; other folders may reuse
        // them (the nearest folder wins, see NearestScope).
        const uri = AstUtils.getDocument(document).uri;
        for (const element of document.elements) {
            if (!('name' in element)) continue;
            const name = element.name;
            const clashes = this.indexManager.allElements()
                .filter(d => d.name === name && (d.type === element.$type || isCallableType(d.type) && isCallableType(element.$type)))
                .filter(d => isBuiltinUri(d.documentUri) || isBuiltinUri(uri) || folderDistance(uri, d.documentUri) === 0)
                .count();
            if (clashes > 1) {
                accept('error', `'${name}' ist mehrfach definiert.`, { node: element, property: 'name' });
            }
        }
    }

    checkBuiltinOnly(node: ElementDecl | FunctionDecl, accept: ValidationAcceptor): void {
        if (!isBuiltinUri(AstUtils.getDocument(node).uri)) {
            accept('error', "'builtin' ist der eingebauten Bibliothek vorbehalten.", { node, keyword: 'builtin' });
        }
        node.parameters.filter(p => p.isState).forEach(p =>
            accept('error', 'Zustandsparameter gibt es nur bei Komponenten.', { node: p, keyword: 'state' }));
    }

    /** Built-in functions have only a signature (prelude); user functions have an expression body and must not recurse. */
    checkFunction(fn: FunctionDecl, accept: ValidationAcceptor): void {
        if (fn.builtin) {
            this.checkBuiltinOnly(fn, accept);
            if (fn.body) accept('error', 'Eingebaute Funktionen haben keinen Rumpf.', { node: fn, property: 'body' });
            return;
        }
        if (!fn.body) {
            accept('error', `Funktion '${fn.name}' braucht einen Rumpf: fn ${fn.name}(…): Typ = Ausdruck.`, { node: fn, property: 'name' });
            return;
        }
        fn.parameters.forEach(p => {
            if (p.isState) accept('error', 'Zustandsparameter gibt es nur bei Komponenten.', { node: p, keyword: 'state' });
            if (p.variadic) accept('error', 'Variadische Parameter sind eingebauten Funktionen vorbehalten.', { node: p, keyword: '...' });
            if (p.defaultValue) this.expectAssignable(p.defaultValue, this.types.declaredType(p.type), accept, 'Standardwert');
        });
        this.expectAssignable(fn.body, this.types.declaredType(fn.returnType), accept, 'Ergebnis');
        const cycle = this.findCycle(fn);
        if (cycle) accept('error', `Rekursion ist nicht erlaubt: ${cycle.join(' → ')}.`, { node: fn, property: 'name' });
    }

    checkTypeReference(ref: TypeReference, accept: ValidationAcceptor): void {
        if (!this.types.resolveTypeReference(ref)) {
            accept('error', `Unbekannter Typ '${ref.name}'.`, { node: ref, property: 'name' });
            return;
        }
        const arity = TypeSystem.TYPE_ARITY[ref.name] ?? (ref.name === 'Interval' ? ref.arguments.length : 0);
        if (ref.arguments.length !== arity) {
            accept('error', `'${ref.name}' erwartet ${arity} Typargument(e).`, { node: ref, property: 'name' });
        }
    }

    checkComponent(component: Component, accept: ValidationAcceptor): void {
        const responses = component.body.filter(isResponseStatement);
        const nested = AstUtils.streamAllContents(component).filter(isResponseStatement).filter(r => r.$container !== component);
        nested.forEach(r => accept('error', "'response' gehört auf die oberste Ebene der Komponente.", { node: r, keyword: 'response' }));

        const declared = this.types.responseType(component);
        if (declared) {
            if (responses.length === 0) {
                accept('error', `Komponente '${component.name}' deklariert eine Antwort, hat aber keine 'response'-Anweisung.`, { node: component, property: 'name' });
            }
            responses.slice(1).forEach(r => accept('error', "Eine Komponente hat genau eine 'response'.", { node: r, keyword: 'response' }));
            for (const r of responses) {
                this.expectAssignable(r.value, declared, accept, 'Antwort');
            }
        } else {
            responses.forEach(r => accept('error', "'response' ohne Antworttyp; Signatur um ': response T' ergänzen.", { node: r, keyword: 'response' }));
        }

        const names = new Set<string>();
        for (const p of component.parameters) {
            if (names.has(p.name)) accept('error', `Parameter '${p.name}' ist mehrfach deklariert.`, { node: p, property: 'name' });
            names.add(p.name);
            if (p.defaultValue) this.expectAssignable(p.defaultValue, this.types.declaredType(p.type), accept, 'Standardwert');
            if (p.variadic) accept('error', 'Variadische Parameter sind eingebauten Funktionen vorbehalten.', { node: p, keyword: '...' });
            if (p.isState && !p.defaultValue) {
                accept('error', `Zustandsparameter '${p.name}' braucht einen Anfangswert für den ungebundenen Aufruf, z. B. state ${p.name}: … = none.`, { node: p, property: 'name' });
            }
        }

        if (component.acceptsChildren && !AstUtils.streamAllContents(component).some(n => n.$type === 'ChildrenStatement')) {
            accept('warning', `Komponente '${component.name}' nimmt Inhalt, setzt ihn aber nirgends ein ('children' im Rumpf).`, { node: component, property: 'name' });
        }

        const cycle = this.findCycle(component);
        if (cycle) {
            accept('error', `Rekursion ist nicht erlaubt: ${cycle.join(' → ')}.`, { node: component, property: 'name' });
        }
    }

    checkItem(item: Item, accept: ValidationAcceptor): void {
        AstUtils.streamAllContents(item).filter(isResponseStatement)
            .forEach(r => accept('error', "'response' ist nur in Komponenten erlaubt.", { node: r, keyword: 'response' }));
        // Item parameters are fixed per version: the default value is the version used when none is chosen; the domain is declared in versions(…)
        const names = new Set<string>();
        const domains = versionDomains(item);
        for (const p of item.parameters) {
            if (names.has(p.name)) accept('error', `Parameter '${p.name}' ist mehrfach deklariert.`, { node: p, property: 'name' });
            names.add(p.name);
            if (p.isState) accept('error', 'Parameter einer Aufgabe sind feste Werte, kein Zustand.', { node: p, keyword: 'state' });
            if (p.variadic) accept('error', 'Variadische Parameter sind eingebauten Funktionen vorbehalten.', { node: p, keyword: '...' });
            if (p.defaultValue) this.expectAssignable(p.defaultValue, this.types.declaredType(p.type), accept, 'Standardwert');
            else accept('error', `Parameter '${p.name}' braucht einen Standardwert, z. B. ${p.name}: … = 4.`, { node: p, property: 'name' });
            const type = this.types.declaredType(p.type);
            if (!domains.has(p.name) && !(type.kind === 'primitive' && type.name === 'Bool')) {
                accept('error', `Wertebereich für '${p.name}' fehlt: versions(when: ${p.name} in 1 .. 10 and …).`, { node: p, property: 'name' });
            }
        }
        this.checkRules(item, accept);
    }

    /**
     * Accommodation rules of an item: `allow` is a study rule (booklet), `versions` decides numbers, not accommodations,
     * and a variant that `deny` switches off is never shown.
     */
    protected checkRules(item: Item, accept: ValidationAcceptor): void {
        const statement = (name: string) => item.body.find(s => builtinElementOf(s) === name) as ContentStatement | undefined;
        const allow = statement('allow');
        if (allow) {
            accept('warning', 'Zulassungen sind Studienregeln und gehören ins Testheft (allow im booklet). Eine Aufgabe schließt mit deny({…}, reason: "…") aus, was sie verfälschen würde.', { node: allow });
        }
        const versions = statement('versions');
        if (versions && /\baccommodations\s*\(/.test(versions.$cstNode?.text ?? '')) {
            if (item.parameters.length === 0) {
                accept('warning', 'Welche Anpassungen gelten, regeln deny(…) und allow(…): deny({read_aloud}, reason: "…").', { node: versions });
            } else {
                accept('info', 'Die Zahlen hängen hier von Anpassungen ab: Diese Fassungen sind leichter oder schwerer, nicht nur anders dargestellt. Ergebnisse sind nicht direkt vergleichbar.', { node: versions });
            }
        }
        const deny = statement('deny');
        const denied = new Set((deny && this.argumentText(deny, 'accommodations'))?.match(/[a-z_]+/g) ?? []);
        if (!deny || denied.size === 0) return;
        // A variant is the accommodation's own; simple language also serves easy language unless that has its own
        const off = (kind: string, easyThere: boolean) =>
            kind === 'simple_language' ? denied.has('simple_language') && (denied.has('easy_language') || easyThere) : denied.has(kind);
        for (const node of AstUtils.streamAllContents(item)) {
            if (isContentStatement(node) && builtinElementOf(node) === 'variant') {
                const kind = this.argumentText(node, 'kind') ?? '';
                const siblings = isContentStatement(node.$container) ? node.$container.body : [];
                const easyThere = siblings.some(s => builtinElementOf(s) === 'variant' && this.argumentText(s as ContentStatement, 'kind') === 'easy_language');
                if (off(kind, easyThere)) {
                    accept('warning', `Die Variante '${kind}' wird nie gezeigt: deny(…) schließt die Anpassung aus.`, { node });
                }
            } else if (isReference(node) && builtinCallOf(node) === 'wording') {
                const args = matchArguments(node)?.matches ?? [];
                const easyThere = args.some(m => m.parameter.name === 'easy');
                for (const m of args) {
                    if ((m.parameter.name === 'simple' || m.parameter.name === 'easy') && off(`${m.parameter.name}_language`, easyThere)) {
                        accept('warning', `Die Sprachstufe '${m.parameter.name}' wird nie gezeigt: deny(…) schließt die Anpassung aus.`, { node: m.argument.value });
                    }
                }
            }
        }
    }

    /** Bindings, state, `let` and parameters must have unique names within an item or component. */
    checkUniqueNames(owner: Item | Component, accept: ValidationAcceptor): void {
        const seen = new Map<string, AstNode>();
        owner.parameters.forEach(p => seen.set(p.name, p));
        const declarations = AstUtils.streamAllContents(owner)
            .filter((n): n is Binding | StateDecl | LetDecl => isBinding(n) || isStateDecl(n) || isLetDecl(n))
            .filter(n => ownerOf(n) === owner);
        for (const decl of declarations) {
            if (seen.has(decl.name)) {
                accept('error', `Name '${decl.name}' ist in ${owner.$type === Item.$type ? 'dieser Aufgabe' : 'dieser Komponente'} bereits vergeben.`, { node: decl, property: 'name' });
            }
            seen.set(decl.name, decl);
        }
    }

    // --- Statements -------------------------------------------------------------------

    checkState(state: StateDecl, accept: ValidationAcceptor): void {
        if (!isComponent(ownerOf(state))) {
            accept('error', "Zustände gehören in Komponenten; eine Aufgabe besteht aus Komponenten, ihre Antworten entstehen über Bindungen (name = Komponente(…)).", { node: state, keyword: 'state' });
        } else if (state.$container !== ownerOf(state)) {
            accept('error', "'state' gehört auf die oberste Ebene der Komponente.", { node: state, keyword: 'state' });
        }
        this.expectAssignable(state.initial, this.types.declaredType(state.type), accept, 'Anfangswert');
    }

    checkLet(decl: LetDecl, accept: ValidationAcceptor): void {
        if (decl.type) this.expectAssignable(decl.value, this.types.declaredType(decl.type), accept, 'Wert');
        // A derived value must not depend on itself, directly or through other lets
        const seen = new Set<LetDecl>();
        const dependsOnSelf = (d: LetDecl): boolean => [d.value, ...AstUtils.streamAllContents(d.value)].some(n => {
            if (!isReference(n) || !isLetDecl(n.target.ref)) return false;
            const target = n.target.ref;
            if (target === decl) return true;
            if (seen.has(target)) return false;
            seen.add(target);
            return dependsOnSelf(target);
        });
        if (dependsOnSelf(decl)) accept('error', `'${decl.name}' hängt von sich selbst ab.`, { node: decl, property: 'name' });
    }

    checkBinding(binding: Binding, accept: ValidationAcceptor): void {
        if (isComponent(ownerOf(binding))) {
            accept('error', 'Antworten werden in Aufgaben gebunden. In einer Komponente den Zustand der inneren Komponente über einen Zustandsparameter binden, z. B. Select(…, chosen: chosen[r]).', { node: binding, property: 'name' });
            return;
        }
        if (AstUtils.getContainerOfType(binding, isForStatement)) {
            accept('error', 'Antworten in Schleifen sind nicht erlaubt; das Antwortschema muss vor der Testung feststehen.', { node: binding, property: 'name' });
        }
        const value = binding.value;
        if (!isReference(value) || (!value.isCall && !isComponent(value.target.ref))) {
            accept('error', 'Eine Bindung benennt die Antwort eines Komponentenaufrufs, z. B. name = Gap(label: "…").', { node: binding, property: 'value' });
            return;
        }
        const target = value.target.ref;
        if (!value.isCall) {
            return; // reported by checkReference
        }
        if (target && !isComponent(target)) {
            accept('error', 'Eine Bindung benennt die Antwort eines Komponentenaufrufs, z. B. name = Gap(label: "…").', { node: binding, property: 'value' });
        } else if (target && !target.responseType) {
            accept('error', `Komponente '${target.name}' liefert keine Antwort.`, { node: binding, property: 'value' });
        }
    }

    checkContentStatement(statement: ContentStatement, accept: ValidationAcceptor): void {
        this.checkStructure(statement, accept);
        const expr = statement.expression;
        const target = isReference(expr) ? expr.target.ref : undefined;
        // Text after a non-element (`mark("ihr") " danach"`, `"eins" "zwei"`) is separate content, not a child;
        // a component declaring `children` takes content like an element
        const takesContent = isElementDecl(target) || (isComponent(target) && target.acceptsChildren);
        if (statement.hasBody || (statement.text !== undefined && takesContent)) {
            if (isComponent(target) && target.acceptsChildren) {
                // The response of a component with content stays unbound (bindings cannot carry content)
                if (target.responseType) {
                    accept('warning', `Die Antwort von '${target.name}' wird nicht gespeichert; eine Komponente mit Inhalt kann nicht gebunden werden.`, { node: statement });
                }
                return;
            }
            if (!isElementDecl(target)) {
                const what = 'Inhalt in { … }';
                if (isComponent(target)) {
                    accept('error', `Komponente '${target.name}' nimmt keinen Inhalt; dafür in der Signatur 'children' angeben.`, { node: statement, property: 'expression' });
                } else if (target || !isReference(expr)) {
                    accept('error', `${what} ist nur nach einem Element wie p, section oder group möglich.`, { node: statement, property: 'expression' });
                }
            } else if (!target.acceptsChildren) {
                accept('error', `Element '${target.name}' hat keinen Inhalt.`, { node: statement, property: statement.hasBody ? 'body' : 'text' });
            }
            if (isElementDecl(target)) this.checkTablePlacement(statement, target, accept);
            return;
        }
        // Bound state parameter: the response flows into the caller's state, so no binding is needed
        const bindsState = isReference(expr) && (matchArguments(expr)?.matches.some(m => m.parameter.isState) ?? false);
        if (isReference(expr) && isComponent(target) && target.responseType && !bindsState) {
            accept('warning', `Die Antwort von '${target.name}' wird nicht gespeichert. Bindung angeben: name = ${target.name}(…).`,
                { node: statement, data: diagnosticData(IssueCodes.UnboundResponse) });
            return;
        }
        if (isReference(expr) && (isElementDecl(target) || isComponent(target))) {
            return;
        }
        const type = this.types.typeOf(expr);
        if (!isAssignable(type, Types.Content)) {
            accept('error', `Ein Wert vom Typ ${printType(type)} kann nicht als Inhalt dargestellt werden.`, { node: statement, property: 'expression' });
        }
    }

    /** `children` inserts the caller's content: only in components declaring `children`, never inside a loop. */
    checkChildrenStatement(node: ChildrenStatement, accept: ValidationAcceptor): void {
        const component = AstUtils.getContainerOfType(node, isComponent);
        if (!component) {
            accept('error', "'children' gibt es nur in Komponenten.", { node, keyword: 'children' });
        } else if (!component.acceptsChildren) {
            accept('error', `Komponente '${component.name}' nimmt keinen Inhalt; dafür in der Signatur 'children' angeben.`, { node, keyword: 'children' });
        } else if (AstUtils.getContainerOfType(node, isForStatement)) {
            accept('error', "'children' steht nicht in einer Schleife; der Inhalt erscheint genau einmal.", { node, keyword: 'children' });
        }
    }

    /** `cell` belongs in a table row (`row` inside `table`), a header `row(head: true)` in a `table`. Not checked across component boundaries. */
    protected checkTablePlacement(statement: ContentStatement, element: ElementDecl, accept: ValidationAcceptor): void {
        if (!isBuiltinUri(AstUtils.getDocument(element).uri)) return;
        // Groups (e.g. one radio group per row) are transparent to the table structure
        const skipGroups = (e: ReturnType<typeof enclosingElement>) => {
            while (e && e !== 'component' && e.name === 'group') e = enclosingElement(e.statement);
            return e;
        };
        const parent = skipGroups(enclosingElement(statement));
        if (parent === 'component') return;
        const row = parent?.name === 'row' ? skipGroups(enclosingElement(parent.statement)) : undefined;
        if (row === 'component') return;
        if (element.name === 'cell' && row?.name !== 'table') {
            accept('error', "'cell' steht in einer Tabellenzeile: table { row { cell … } }.", { node: statement, property: 'expression' });
        }
        if (element.name === 'stimulus' && parent !== undefined && parent.name !== 'page') {
            accept('error', "'stimulus' steht direkt in der Aufgabe (für alle Seiten) oder in einer Seite.", { node: statement, property: 'expression' });
        }
        const head = isReference(statement.expression)
            && matchArguments(statement.expression)?.matches.some(m => m.parameter.name === 'head' && isValueArgument(m.argument)
                && isBooleanLiteral(m.argument.value) && m.argument.value.value);
        if (element.name === 'row' && head && parent?.name !== 'table') {
            accept('error', "'row(head: true)' ist die Kopfzeile einer Tabelle: table { row(head: true) { cell … } }.", { node: statement, property: 'expression' });
        }
    }

    checkIf(node: IfExpression, accept: ValidationAcceptor): void {
        this.expectAssignable(node.condition, Types.Bool, accept, 'Bedingung');
    }

    checkFor(node: ForStatement, accept: ValidationAcceptor): void {
        const type = this.types.typeOf(node.iterable);
        const element = iterableElement(type);
        if (!element) {
            accept('error', `Über ${printType(type)} kann nicht iteriert werden (erwartet: Liste, Menge oder ganzzahliger Bereich).`, { node, property: 'iterable' });
        } else if (node.variables.length === 2 && type.kind === 'set') {
            accept('error', 'Mengen haben keinen Index; nur eine Schleifenvariable angeben.', { node, property: 'variables', index: 1 });
        }
    }

    // --- Expressions --------------------------------------------------------------------

    checkIndex(node: IndexAccess, accept: ValidationAcceptor): void {
        const list = this.types.typeOf(node.receiver);
        const inner = list.kind === 'optional' ? list.inner : list;
        if (inner.kind !== 'list' && inner.kind !== 'any') {
            accept('error', `Index nur bei Listen möglich, gefunden ${printType(list)}.`, { node, property: 'receiver' });
        }
        this.expectAssignable(node.index, Types.Int, accept, 'Index');
    }

    checkBinary(node: Expression, accept: ValidationAcceptor): void {
        if (!isBinaryExpression(node)) return;
        // A choice response compared with option texts: each text must be an option; then the numbers are compared
        const byText = optionComparison(node);
        if (byText) {
            for (const text of byText.texts) {
                if (optionNumber(byText.options, text.value) === undefined) {
                    accept('error', `„${text.value}“ ist keine Option. Optionen: ${byText.options.map(o => `„${o}“`).join(', ')}.`, { node: text });
                } else if (byText.options.indexOf(text.value) !== byText.options.lastIndexOf(text.value)) {
                    accept('error', `Die Option „${text.value}“ kommt mehrfach vor; hier die Nummer verwenden.`, { node: text });
                }
            }
            // Shape as with numbers: a set response compares with a set ({"…"}), a single one with a text; `in` the other way
            const response = this.types.typeOf(byText.side === 'left' ? node.right : node.left);
            const isSet = response.kind === 'set';
            const textSide = byText.side === 'left' ? node.left : node.right;
            const asSet = isSetLiteral(textSide);
            const fits = node.operator === 'in' ? (byText.side === 'left' ? isSet && !asSet : !isSet && asSet) : isSet === asSet;
            if (!fits) {
                const example = isSet ? `{"${byText.texts[0].value}"}` : `"${byText.texts[0].value}"`;
                accept('error', `Die Antwort ist ${isSet ? 'eine Menge von Optionen' : 'eine einzelne Option'}: ${example}.`, { node: textSide });
            }
            return;
        }
        const numbered = numberedOptions(node);
        if (numbered) {
            accept('hint', `Option lesbarer als Text: ${numbered.text}.`, { node: numbered.target, data: diagnosticData(IssueCodes.OptionNumbers) });
        }
        const left = this.types.typeOf(node.left), right = this.types.typeOf(node.right);
        const fail = () => accept('error', `Operator '${node.operator}' passt nicht zu ${printType(left)} und ${printType(right)}.`, { node, property: 'operator' });
        switch (node.operator) {
            case 'and': case 'or':
                this.expectAssignable(node.left, Types.Bool, accept, 'Operand');
                this.expectAssignable(node.right, Types.Bool, accept, 'Operand');
                break;
            case '==': case '!=':
                if (!isAssignable(left, right) && !isAssignable(right, left)) fail();
                break;
            case '<': case '<=': case '>': case '>=':
                if (!isOrdered(left) || !isOrdered(right)) fail();
                break;
            case 'in': {
                const element = right.kind === 'interval' ? right.element : iterableElement(right);
                if (!element || (!isAssignable(left, element) && !isAssignable(element, left))) fail();
                break;
            }
            default:
                if (this.types.typeOf(node).kind === 'any' && left.kind !== 'any' && right.kind !== 'any') fail();
        }
    }

    /** A name declared in several folders at the same distance cannot be resolved by nearness. */
    protected checkAmbiguous(ref: Reference, target: AstNode, accept: ValidationAcceptor): void {
        if (!isDocument(target.$container)) return;
        const from = AstUtils.getDocument(ref).uri;
        const to = AstUtils.getDocument(target).uri;
        if (isBuiltinUri(to) || to.toString() === from.toString()) return;
        const nearest = folderDistance(from, to);
        const rivals = this.indexManager.allElements(target.$type)
            .filter(d => d.name === ref.target.$refText && d.documentUri.toString() !== to.toString() && folderDistance(from, d.documentUri) === nearest)
            .toArray();
        if (rivals.length > 0) {
            const where = [to, ...rivals.map(d => d.documentUri)].map(u => UriUtils.relative(UriUtils.dirname(from), u));
            accept('error', `'${ref.target.$refText}' ist mehrdeutig: ${where.join(', ')}. In den nächsten Ordner verschieben oder umbenennen.`,
                { node: ref, property: 'target' });
        }
    }

    checkReference(ref: Reference, accept: ValidationAcceptor): void {
        const target = ref.target.ref;
        if (!target) return;
        if (isFunctionDecl(target) && target.name === 'manual' && isBuiltinUri(AstUtils.getDocument(target).uri)) {
            this.checkManual(ref, accept);
        }
        const coding = builtinCallOf(ref);
        if (coding === 'correct' || coding === 'codes' || coding === 'code') this.checkCodingCall(ref, coding, accept);
        if (isFunctionDecl(target) && target.name === 'image' && isBuiltinUri(AstUtils.getDocument(target).uri)) {
            const alt = matchArguments(ref)?.matches.find(m => m.parameter.name === 'alt')?.argument.value;
            if (alt && isEmptyString(alt)) {
                accept('warning', 'Leerer Alternativtext ist nur für rein dekorative Bilder zulässig.', { node: alt });
            }
        }
        if (isFunctionDecl(target) && target.name === 'math' && isBuiltinUri(AstUtils.getDocument(target).uri)) {
            const tex = matchArguments(ref)?.matches.find(m => m.parameter.name === 'tex')?.argument.value;
            if (tex && !isStringLiteral(tex)) {
                accept('error', 'Formel als festen Text angeben, z. B. math("\\frac{3}{4}").', { node: tex });
            } else if (tex && isStringLiteral(tex)) {
                const error = mathError(tex.value);
                if (error) accept('error', `Formel: ${error}`, { node: tex });
            }
        }
        this.checkAmbiguous(ref, target, accept);
        const callable = isComponent(target) || isElementDecl(target) || isFunctionDecl(target);
        if (ref.isCall && !callable) {
            accept('error', `'${ref.target.$refText}' ist nicht aufrufbar.`, { node: ref, property: 'target' });
            return;
        }
        if (!ref.isCall && callable && !(isElementDecl(target) && isElementPosition(ref))) {
            accept('error', `'${target.name}' muss aufgerufen werden: ${target.name}(…).`, { node: ref, property: 'target' });
            return;
        }
        if (!callable) return;

        const info = matchArguments(ref);
        if (!info) return;
        info.problems.forEach(p => accept('error', p.message, { node: p.argument }));
        if (info.missing.length > 0) {
            const names = info.missing.map(p => `'${p.name}'`).join(', ');
            const code = info.missing.some(p => p.name === 'label') ? IssueCodes.MissingLabel : undefined;
            accept('error', `Fehlende Pflichtangabe ${names} für '${target.name}'.`, { node: ref, property: 'target', data: code ? diagnosticData(code) : undefined });
        }
        for (const { argument, parameter } of info.matches) {
            const expected = this.types.expectedArgumentType(ref, parameter);
            this.expectAssignable(argument.value, expected, accept, `Argument '${parameter.name}'`);
            if (parameter.name === 'bind' && isElementDecl(target)) {
                this.checkBindArgument(argument.value, accept);
            }
            if (parameter.isState && isComponent(target)) {
                // State parameter: bound to the caller's own state and written in both directions
                this.checkBindArgument(argument.value, accept);
                const actual = this.types.typeOf(argument.value);
                if (!isAssignable(expected, actual) && actual.kind !== 'any') {
                    accept('error', `Zustandsparameter '${parameter.name}' (${printType(expected)}) passt nicht zum gebundenen Zustand (${printType(actual)}).`, { node: argument.value });
                }
            }
            // Media paths passed directly to image/media/… or to components (e.g. image options as a list)
            const value = argument.value;
            if (MEDIA_PARAMETERS.has(`${target.name}.${parameter.name}`)) {
                this.checkMediaFile(value, accept);
            } else if (isComponent(target)) {
                const texts = isListLiteral(value) ? value.elements : [value];
                texts.filter(t => isStringLiteral(t) && isMediaPath(t.value)).forEach(t => this.checkMediaFile(t, accept));
            }
        }
        this.checkCaptions(ref, target, accept);
        this.checkOwnSchedule(ref, target, accept);
        if (isElementDecl(target)) {
            this.checkElementCall(ref, target, accept);
        } else if (isFunctionDecl(target) && ref.arguments.some(a => a.$type === 'Handler')) {
            accept('error', 'Ereignisse gibt es nur bei Elementen.', { node: ref });
        }
    }

    /** At most one fixed schedule (`Listen` from std) per item: several would run at the same time. */
    checkSchedules(item: Item, accept: ValidationAcceptor): void {
        const listens = AstUtils.streamAllContents(item).filter(isReference)
            .filter(r => r.target.ref?.name === 'Listen' && isComponent(r.target.ref) && isBuiltinUri(AstUtils.getDocument(r.target.ref).uri)).toArray();
        listens.slice(1).forEach(r => accept('warning', 'Mehrere Listen in einer Aufgabe laufen gleichzeitig; je Aufgabe ein fester Ablauf.', { node: r }));
    }

    /**
     * A schedule of one's own (`flow` holding navigation or advancing) works, but comparative tests need the same
     * schedule for everyone: Listen from std.
     */
    protected checkOwnSchedule(ref: Reference, target: AstNode, accept: ValidationAcceptor): void {
        if (!isElementDecl(target) || target.name !== 'flow' || !isBuiltinUri(AstUtils.getDocument(target).uri)) return;
        if (isBuiltinUri(AstUtils.getDocument(ref).uri)) return;
        const own = matchArguments(ref)?.matches.some(m => m.parameter.name === 'navigation' || m.parameter.name === 'advance');
        if (own) accept('warning', 'Eigener fester Ablauf: in Vergleichstests Listen aus std verwenden, damit er für alle gleich ist.', { node: ref, property: 'target' });
    }

    /** A video needs captions (hearing impairment, BITV): any call with `src` and `captions`, e.g. media, Listen, Play. */
    protected checkCaptions(ref: Reference, target: AstNode, accept: ValidationAcceptor): void {
        if (!('parameters' in target) || !(target.parameters as Array<{ name: string }>).some(p => p.name === 'captions')) return;
        const matches = matchArguments(ref)?.matches ?? [];
        const src = matches.find(m => m.parameter.name === 'src')?.argument.value;
        if (src && isStringLiteral(src) && /\.(mp4|m4v|webm|ogv|mov)$/i.test(src.value) && !matches.some(m => m.parameter.name === 'captions')) {
            accept('warning', 'Video ohne Untertitel: captions mit einer WebVTT-Datei angeben (für Hörgeschädigte).', { node: src });
        }
    }

    /** Relative media paths must exist relative to the item's file (only checked for file: URIs). */
    protected checkMediaFile(value: Expression, accept: ValidationAcceptor): void {
        if (!isStringLiteral(value) || value.value.length === 0 || /^[a-z][\w+.-]*:/i.test(value.value)) return;
        const document = AstUtils.getDocument(value).uri;
        if (document.scheme !== 'file') return;
        const file = UriUtils.joinPath(UriUtils.dirname(document), value.value);
        if (!this.fileSystem.existsSync(file)) {
            accept('warning', `Datei '${value.value}' nicht gefunden (gesucht in ${UriUtils.dirname(document).path}).`, { node: value, data: diagnosticData(IssueCodes.MissingMedia) });
        }
    }

    protected checkBindArgument(value: Expression, accept: ValidationAcceptor): void {
        // bind: list[i] binds one element of a list state
        const target = isIndexAccess(value) ? value.receiver : value;
        if (isIndexAccess(value) && this.types.typeOf(target).kind !== 'list') {
            accept('error', "'bind' mit Index erwartet einen Listenzustand, z. B. bind: faces[i].", { node: value });
            return;
        }
        value = target;
        const state = isReference(value) && !value.isCall ? value.target.ref : undefined;
        if (!isStateDecl(state) && !(isParameter(state) && state.isState)) {
            accept('error', "'bind' erwartet einen eigenen Zustand (state).", { node: value });
        } else if (ownerOf(state) !== ownerOf(value)) {
            accept('error', `Zustand '${state.name}' gehört nicht zu dieser Komponente.`, { node: value });
        }
    }

    protected checkElementCall(ref: Reference, element: ElementDecl, accept: ValidationAcceptor): void {
        const info = matchArguments(ref)!;
        const argOf = (name: string) => info.matches.find(m => m.parameter.name === name)?.argument.value;

        // Every interactive atom needs an accessible name
        if (element.events.length > 0) {
            const label = argOf('label');
            const statement = ref.$container;
            const hasContent = isContentStatement(statement) && statement.expression === ref
                && (statement.hasBody && statement.body.length > 0 || statement.text !== undefined);
            if ((!label || isNoneLiteral(label) || isEmptyString(label)) && !hasContent) {
                accept('error', `Interaktives Atom '${element.name}' braucht einen zugänglichen Namen (label oder Inhalt).`,
                    { node: ref, property: 'target', data: diagnosticData(IssueCodes.MissingLabel) });
            }
        }

        // radio only inside a radiogroup
        const role = argOf('role');
        if (element.name === 'toggle' && role) {
            this.checkRadioInRadiogroup(ref, role, accept);
        }
    }

    protected checkRadioInRadiogroup(toggle: Reference, role: Expression, accept: ValidationAcceptor): void {
        const group = findEnclosingGroup(toggle);
        const groupRole = group ? matchArguments(group)?.matches.find(m => m.parameter.name === 'role')?.argument.value : undefined;
        // Both roles may depend on the same conditions, e.g. `if max == 1 then radio else checkbox`, so check every
        // assignment of truth values (capped at 4 distinct conditions).
        const conditions = [...collectConditions(role), ...(groupRole ? collectConditions(groupRole) : [])];
        const unique = [...new Map(conditions.map(c => [c, c])).keys()].slice(0, 4);
        for (let mask = 0; mask < 1 << unique.length; mask++) {
            const assignment = new Map(unique.map((c, i) => [c, (mask & (1 << i)) !== 0]));
            const toggleRole = evaluateRole(role, assignment);
            if (toggleRole !== 'radio') continue;
            const containerRole = groupRole ? evaluateRole(groupRole, assignment) : group ? 'group' : undefined;
            if (containerRole !== 'radiogroup') {
                accept('error', "Rolle 'radio' ist nur innerhalb einer Gruppe mit 'role: radiogroup' erlaubt.", { node: role });
                return;
            }
        }
    }

    checkHandler(handler: Handler, accept: ValidationAcceptor): void {
        const call = handler.$container;
        if (isReference(call) && call.target.ref && !isElementDecl(call.target.ref)) {
            accept('error', 'Ereignisse gibt es nur bei Elementen.', { node: handler, keyword: 'on' });
        }
    }

    checkAssignment(assignment: Assignment, accept: ValidationAcceptor): void {
        const state = assignment.target.ref;
        if (!state) return;
        if (isParameter(state) && !state.isState) {
            accept('error', `Parameter '${state.name}' ist nicht änderbar; als Zustandsparameter deklarieren: state ${state.name}: …`, { node: assignment, property: 'target' });
            return;
        }
        if (ownerOf(state) !== ownerOf(assignment)) {
            accept('error', `Nur eigene Zustände dürfen geändert werden; '${state.name}' gehört nicht zu dieser Komponente.`, { node: assignment, property: 'target' });
        }
        this.expectAssignable(assignment.value, this.types.declaredType(state.type), accept, 'Zuweisung');
    }

    // --- Booklets -------------------------------------------------------------------------

    checkBooklet(booklet: Booklet, accept: ValidationAcceptor): void {
        // A booklet body holds parts and at most one versions(…)
        const parts = booklet.body.filter(s => builtinElementOf(s) === 'part');
        for (const s of booklet.body) {
            const name = builtinElementOf(s);
            if (name !== 'part' && name !== 'versions' && name !== 'allow' && name !== 'deny') {
                accept('error', "Ein Testheft besteht aus Teilen: part(\"Titel\") { aufgabe1 aufgabe2 }; dazu Studienregeln wie allow({…}).", { node: s });
            }
        }
        if (parts.length === 0) {
            accept('error', `Testheft '${booklet.name}' braucht mindestens einen Teil (part).`, { node: booklet, property: 'name' });
        }
        const items = new Set<string>();
        for (const ref of AstUtils.streamAllContents(booklet).filter(n => itemRefOf(n) !== undefined)) {
            const name = itemRefOf(ref)!.name;
            if (items.has(name)) accept('error', `Aufgabe '${name}' kommt im Testheft mehrfach vor.`, { node: ref });
            items.add(name);
        }
        if (items.size === 0 && parts.length > 0) {
            accept('warning', `Testheft '${booklet.name}' enthält keine Aufgabe.`, { node: booklet, property: 'name' });
        }
    }

    /**
     * Placement rules for flow and booklet elements: `variant` inside an element, `versions` directly in an item or
     * booklet, `part` in a booklet, `instruction` and item references in a part.
     */
    protected checkStructure(statement: ContentStatement, accept: ValidationAcceptor): void {
        const name = builtinElementOf(statement);
        const parent = statement.$container;
        const parentElement = builtinElementOf(parent);
        if (itemRefOf(statement)) {
            if (parentElement !== 'part') accept('error', 'Aufgaben stehen in einem Teil eines Testhefts: part("Titel") { aufgabe1 }.', { node: statement });
            return;
        }
        switch (name) {
            case 'variant': {
                if (!isContentStatement(parent) || !builtinElementOf(parent) && !isComponent(isReference(parent.expression) ? parent.expression.target.ref : undefined)) {
                    accept('error', "'variant' steht im Inhalt des Elements, dessen Variante es ist, z. B. p { \"…\" variant(simple_language) \"…\" }.", { node: statement });
                }
                const kind = this.argumentText(statement, 'kind');
                const content = statement.text !== undefined ? 1 : statement.body.filter(isContentStatement).length;
                if (kind && !['simple_language', 'easy_language', 'extended_descriptions'].includes(kind)) {
                    accept('error', `'${kind}' hat keine Variante: Varianten gibt es für simple_language, easy_language und extended_descriptions. `
                        + 'Die übrigen Anpassungen wirken ohne Zutun der Aufgabe.', { node: statement });
                } else if (kind === 'simple_language' || kind === 'easy_language') {
                    // Language level: a text or a block replacing the content (e.g. a whole reading passage)
                    if (content === 0) accept('error', `Die Sprachstufe '${kind}' braucht einen Inhalt: variant(${kind}) "…" oder variant(${kind}) { p "…" p "…" }.`, { node: statement });
                    if (AstUtils.streamAllContents(statement).some(isBinding)) {
                        accept('error', 'In einer Sprachstufe stehen nur Inhalte, keine Antworten: Die Antwort bleibt im Original, die Stufe ersetzt den Text davor.', { node: statement });
                    }
                    // Next to a response, a level replaces the text before it; a block would have to repeat the response
                    if (statement.text === undefined && isContentStatement(parent) && parent.body.some(isBinding)) {
                        accept('error', `Neben einer Antwort ersetzt die Sprachstufe nur den Text davor: variant(${kind}) "…".`, { node: statement });
                    }
                } else if (content !== 1 || statement.body.some(s => !isContentStatement(s))) {
                    accept('error', "Eine Beschreibung hat genau einen Inhalt: variant(extended_descriptions) \"…\".", { node: statement });
                }
                const siblings = isContentStatement(parent) ? parent.body : [];
                if (kind && siblings.some(s => s !== statement && builtinElementOf(s) === 'variant' && this.argumentText(s as ContentStatement, 'kind') === kind
                    && siblings.indexOf(s) < siblings.indexOf(statement))) {
                    accept('error', `Variante '${kind}' kommt mehrfach vor.`, { node: statement });
                }
                break;
            }
            case 'versions':
                if (!isItem(parent) && !isBooklet(parent)) {
                    accept('error', "'versions' steht direkt in einer Aufgabe oder einem Testheft.", { node: statement });
                } else if (parent.body.filter(s => builtinElementOf(s) === 'versions').indexOf(statement) > 0) {
                    accept('error', 'Nur ein versions(…) je Aufgabe bzw. Testheft.', { node: statement });
                }
                break;
            case 'deny':
            case 'allow':
                if (!isItem(parent) && !isBooklet(parent)) {
                    accept('error', `'${name}' steht direkt in einer Aufgabe oder einem Testheft.`, { node: statement });
                } else if (parent.body.filter(s => builtinElementOf(s) === name).indexOf(statement) > 0) {
                    accept('error', `Nur ein ${name}(…) je Aufgabe bzw. Testheft; alle Anpassungen in eine Menge.`, { node: statement });
                }
                break;
            case 'part':
                if (!isBooklet(parent)) accept('error', "'part' steht in einem Testheft (booklet).", { node: statement });
                if (!statement.body.some(s => itemRefOf(s) || builtinElementOf(s) === 'instruction')) {
                    accept('warning', 'Der Teil ist leer.', { node: statement });
                }
                break;
            case 'instruction':
                if (parentElement !== 'part') accept('error', "'instruction' steht in einem Teil eines Testhefts.", { node: statement });
                AstUtils.streamAllContents(statement).filter(isBinding)
                    .forEach(b => accept('error', 'Instruktionsseiten haben keine Antworten; für Antworten eine Aufgabe (item) verwenden.', { node: b, property: 'name' }));
                break;
        }
    }

    protected argumentOf(statement: ContentStatement, param: string): Expression | undefined {
        return isReference(statement.expression) ? matchArguments(statement.expression)?.matches.find(m => m.parameter.name === param)?.argument.value : undefined;
    }

    protected argumentText(statement: ContentStatement, param: string): string | undefined {
        return this.argumentOf(statement, param)?.$cstNode?.text;
    }

    // --- Coding --------------------------------------------------------------------------

    checkCoding(coding: Coding, accept: ValidationAcceptor): void {
        const item = coding.item.ref;
        if (!item) return;
        // At most one coding per item, also across files: the first by URI and offset wins, every other one is reported
        const all = this.documents.all
            .flatMap(d => (d.parseResult.value as Document).elements ?? [])
            .filter(e => e.$type === 'Coding' && (e as Coding).item.ref === item)
            .toArray() as Coding[];
        if (all.length > 1) {
            const key = (c: Coding) => `${AstUtils.getDocument(c).uri.toString()}#${c.$cstNode?.offset ?? 0}`;
            const first = all.reduce((a, b) => (key(b) < key(a) ? b : a));
            if (first !== coding) accept('error', `Für '${item.name}' gibt es bereits eine Kodierung (${UriUtils.basename(AstUtils.getDocument(first).uri)}).`, { node: coding, property: 'item' });
        }
        const names = new Set<string>();
        const covered = new Set<Binding>();
        for (const rule of coding.rules) {
            if (names.has(rule.name)) accept('error', `'${rule.name}' ist mehrfach kodiert.`, { node: rule, property: 'name' });
            names.add(rule.name);
            if (!isScoreRule(rule)) ruleSources(rule).forEach(b => covered.add(b));
        }
        for (const binding of bindingsOf(item)) {
            if (!covered.has(binding)) {
                accept('hint', `Antwort '${binding.name}' hat keine automatische Kodierung.`, { node: coding, property: 'item' });
            }
        }
    }

    checkCodingRule(rule: CodingRule, accept: ValidationAcceptor): void {
        const item = rule.$container.item.ref;
        // Derived score: any expression other than correct/codes, e.g. sum_score(a, b)
        if (isScoreRule(rule)) {
            if (item && bindingsOf(item).some(b => b.name === rule.name)) {
                accept('error', `'${rule.name}' ist eine Antwort; kodiert wird sie mit correct(…) oder codes(…).`, { node: rule, property: 'value' });
            } else {
                this.expectAssignable(rule.value, Types.Rational, accept, 'Score');
            }
            return;
        }
        if (!ruleAnswer(rule) && item) {
            const sources = ruleSources(rule);
            if (sources.length === 0) {
                accept('error', `'${rule.name}' ist keine Antwort von '${rule.$container.item.$refText}'; eine Teilaufgabe muss Antworten verwenden.`, { node: rule, property: 'name' });
            } else if (sources.length === 1 && !AstUtils.streamAllContents(rule).some(isIndexAccess)) {
                // A subtask over one element of a list response (e.g. jobs[2]) is intended, so no warning
                accept('warning', `'${rule.name}' ist keine Antwort, sondern eine Teilaufgabe nur über '${sources[0].name}'. Für eine einzelne Antwort deren Namen verwenden.`, { node: rule, property: 'name' });
            }
        }
        for (const ref of AstUtils.streamAllContents(rule).filter(isReference)) {
            if (isCodingRule(ref.target.ref)) {
                accept('error', `Teilaufgabe '${ref.target.$refText}' hat keinen Wert; Bedingungen verwenden Antworten.`, { node: ref, property: 'target' });
            }
        }
        this.checkFeedback(rule, accept);
        if (builtinCallOf(rule.value) !== 'codes') return;
        // codes(code(…), …): literal numbers and scores; a catch-all `when: true` must come last
        const cases = (matchArguments(rule.value as Reference)?.matches ?? []).filter(m => m.parameter.name === 'cases').map(m => m.argument.value);
        const codes = new Set<number>();
        let always = false;
        for (const c of cases) {
            if (builtinCallOf(c) !== 'code') {
                accept('error', 'In codes(…) stehen Codes: code(1, "richtig", score: 1, when: …).', { node: c });
                continue;
            }
            if (always) accept('warning', "Fall wird nie erreicht, da ein Fall mit 'when: true' vorher greift.", { node: c });
            const arg = (name: string) => matchArguments(c as Reference)?.matches.find(m => m.parameter.name === name)?.argument.value;
            const code = arg('code'), score = arg('score'), label = arg('label'), when = arg('when');
            if (!isNumberLiteral(code)) accept('error', 'Codenummer als feste Zahl angeben.', { node: code ?? c });
            else {
                if (codes.has(code.value)) accept('warning', `Code ${code.value} kommt mehrfach vor.`, { node: code });
                codes.add(code.value);
            }
            if (score && !isNumberLiteral(score)) accept('error', 'Score als feste Zahl angeben.', { node: score });
            if (label && !isStringLiteral(label)) accept('error', 'Bezeichnung als festen Text angeben.', { node: label });
            if (isBooleanLiteral(when) && when.value) always = true;
        }
    }

    /**
     * Practice feedback may use parameters and responses ("Dein Dreieck ist 3 Kästchen groß") but no coding functions,
     * since feedback is not part of the coding. If any code of a rule has feedback, every code should have one.
     */
    protected checkFeedback(rule: CodingRule, accept: ValidationAcceptor): void {
        const FEEDBACK = new Set(['right', 'wrong', 'hints', 'solution', 'otherwise', 'feedback']);
        const call = rule.value as Reference;
        const fn = builtinCallOf(call);
        if (fn !== 'correct' && fn !== 'codes') return;
        const matches = matchArguments(call)?.matches ?? [];
        const codeCalls = fn === 'codes' ? matches.filter(m => m.parameter.name === 'cases' && builtinCallOf(m.argument.value) === 'code').map(m => m.argument.value as Reference) : [];
        const feedbackArgs = [...matches, ...codeCalls.flatMap(c => matchArguments(c)?.matches ?? [])].filter(m => FEEDBACK.has(m.parameter.name));
        for (const { argument } of feedbackArgs) {
            const meta = [argument.value, ...AstUtils.streamAllContents(argument.value)]
                .find(n => isReference(n) && ['manual', 'changed', 'displayed', 'sum_score'].includes(builtinCallOf(n) ?? ''));
            if (meta) accept('error', 'Rückmeldungen nennen Parameter und Antworten, aber keine Kodierfunktionen (manual, changed …).', { node: meta });
        }
        if (fn !== 'codes' || feedbackArgs.length === 0) return;
        for (const c of codeCalls) {
            const own = matchArguments(c)?.matches ?? [];
            if (!own.some(m => m.parameter.name === 'feedback')) {
                const code = own.find(m => m.parameter.name === 'code')?.argument.value;
                accept('warning', `Code ${isNumberLiteral(code) ? code.value : ''} hat keine Rückmeldung (feedback: …), andere Codes dieser Regel schon.`, { node: c, property: 'target' });
            }
        }
    }

    /** `correct` and `codes` only as the value of a coding rule; `code` only inside `codes(…)`. */
    protected checkCodingCall(ref: Reference, fn: string, accept: ValidationAcceptor): void {
        const container = ref.$container;
        if ((fn === 'correct' || fn === 'codes') && !(isCodingRule(container) && container.value === ref)) {
            accept('error', `'${fn}' ist der Wert einer Kodierregel: name: ${fn}(…).`, { node: ref, property: 'target' });
        }
        if (fn === 'code' && !(isValueArgument(container) && builtinCallOf(container.$container) === 'codes')) {
            accept('error', "'code' steht in codes(…).", { node: ref, property: 'target' });
        }
    }

    /** `manual(…)` only as a coding condition (alone or combined with and/or/not); criterion and examples as literal text. */
    protected checkManual(ref: Reference, accept: ValidationAcceptor): void {
        let node: AstNode = ref;
        while ((isBinaryExpression(node.$container) && (node.$container.operator === 'and' || node.$container.operator === 'or'))
            || (isUnaryExpression(node.$container) && node.$container.operator === 'not')) {
            node = node.$container;
        }
        // must be the `when` condition of correct(…) or code(…)
        const container = node.$container;
        const call = isValueArgument(container) ? container.$container : undefined;
        const fn = builtinCallOf(call);
        const atCondition = (fn === 'correct' || fn === 'code')
            && matchArguments(call as Reference)?.matches.find(m => m.argument === container)?.parameter.name === 'when'
            && AstUtils.getContainerOfType(call, isCodingRule) !== undefined;
        if (!atCondition) {
            accept('error', "'manual' steht nur als Bedingung einer Kodierung, allein oder mit and/or/not verknüpft.", { node: ref, property: 'target' });
            return;
        }
        for (const { argument, parameter } of matchArguments(ref)?.matches ?? []) {
            const value = argument.value;
            if (parameter.name === 'criterion' && !isStringLiteral(value)) {
                accept('error', 'Kriterium als Text angeben, z. B. "nennt beide Gründe".', { node: value });
            }
            if ((parameter.name === 'yes' || parameter.name === 'no') && !(isListLiteral(value) && value.elements.every(isStringLiteral))) {
                accept('error', `Beispiele als Liste von Texten angeben, z. B. ${parameter.name}: ["…", "…"].`, { node: value });
            }
            if (parameter.name === 'about' && !(isListLiteral(value) && value.elements.every(e => isReference(e) && isBinding(e.target.ref)))) {
                accept('error', 'about: Liste von Antworten der Aufgabe, z. B. about: [reason].', { node: value });
            }
        }
    }


    // --- Helpers -----------------------------------------------------------------------

    /** point(x, y) with two plain arguments: suggest the school notation (x | y). */
    checkPointNotation(ref: Reference, accept: ValidationAcceptor): void {
        if (!ref.isCall || builtinCallOf(ref) !== 'point' || ref.arguments.length !== 2) return;
        if (!ref.arguments.every(a => isValueArgument(a) && !a.parameter)) return;
        accept('hint', 'Punkt kürzer in Schulschreibweise: (x | y).', { node: ref, data: diagnosticData(IssueCodes.PointNotation) });
    }

    /** (x | y): both coordinates are numbers. */
    checkPoint(point: PointLiteral, accept: ValidationAcceptor): void {
        this.expectAssignable(point.x, Types.optional(Types.Rational), accept, 'x-Koordinate');
        this.expectAssignable(point.y, Types.optional(Types.Rational), accept, 'y-Koordinate');
    }

    protected expectAssignable(expr: Expression, expected: Type, accept: ValidationAcceptor, what: string): void {
        const actual = this.types.typeOf(expr);
        if (!isAssignable(actual, expected)) {
            const hint = actual.kind === 'optional' && isAssignable(actual.inner, expected) ? ' (Wert kann none sein)' : '';
            accept('error', `${what}: erwartet ${printType(expected)}, gefunden ${printType(actual)}${hint}.`, { node: expr });
        }
    }

    /**
     * Finds a call cycle through declarations of the same kind (components, or user functions) starting at `start`.
     * Each declaration is visited at most once; otherwise the search grows exponentially with widely shared building blocks.
     */
    protected findCycle<T extends Component | FunctionDecl>(start: T): string[] | undefined {
        const same = (n: unknown): n is T => isComponent(start) ? isComponent(n) : isFunctionDecl(n) && !n.builtin;
        const seen = new Set<T>();
        const visit = (component: T, path: T[]): string[] | undefined => {
            seen.add(component);
            for (const ref of AstUtils.streamAllContents(component).filter(isReference)) {
                const target = ref.target.ref;
                if (!same(target)) continue;
                if (target === start) return [...path, target].map(c => c.name);
                if (!seen.has(target)) {
                    const found = visit(target, [...path, target]);
                    if (found) return found;
                }
            }
            return undefined;
        };
        return visit(start, [start]);
    }
}

/** Extensions that mark a text as a media path, even when it reaches `image.src` etc. only through a component. */
const MEDIA_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|mp3|m4a|ogg|wav|webm|mp4|pdf)$/i;

/** True for a relative media path (no URL scheme, media extension). */
export function isMediaPath(text: string): boolean {
    return text !== '' && !/^[a-z][\w+.-]*:/i.test(text) && MEDIA_EXTENSIONS.test(text);
}

/** Parameters holding a media path, as `element.parameter`; paths are relative to the item file. */
export const MEDIA_PARAMETERS: ReadonlySet<string> = new Set(['image.src', 'media.src', 'media.captions', 'media.described', 'plane.background']);

function isCallableType(type: string): boolean {
    return type === 'Component' || type === 'ElementDecl' || type === 'FunctionDecl';
}

/** True if the type supports < and > (optional numbers too: comparing with none is false). */
function isOrdered(t: Type): boolean {
    if (t.kind === 'optional') return isOrdered(t.inner);
    return t.kind === 'any' || t.kind === 'param' || (t.kind === 'primitive' && ['Int', 'Rational', 'Size', 'Duration'].includes(t.name));
}

function isEmptyString(expr: Expression): boolean {
    return isStringLiteral(expr) && expr.value.trim().length === 0;
}

/** Nearest enclosing `group(…)` call of an element. */
function findEnclosingGroup(ref: Reference): Reference | undefined {
    let node: AstNode | undefined = ref.$container?.$container;
    while (node && !isComponent(node) && !isItem(node)) {
        if (isContentStatement(node) && isReference(node.expression)) {
            const target = node.expression.target.ref;
            if (isElementDecl(target) && target.name === 'group') return node.expression;
        }
        node = node.$container;
    }
    return undefined;
}

function collectConditions(expr: Expression): string[] {
    return isIfExpression(expr)
        ? [conditionKey(expr.condition), ...collectConditions(expr.then), ...collectConditions(expr.else)]
        : [];
}

function conditionKey(expr: Expression): string {
    return (expr.$cstNode?.text ?? '').replace(/\s+/g, '');
}

/** Evaluates a role expression under a truth assignment of its conditions; undefined if not statically known. */
function evaluateRole(expr: Expression, assignment: Map<string, boolean>): string | undefined {
    if (isIfExpression(expr)) {
        const value = isBooleanLiteral(expr.condition) ? expr.condition.value : assignment.get(conditionKey(expr.condition));
        return evaluateRole(value ? expr.then : expr.else, assignment);
    }
    if (isReference(expr)) {
        const target = expr.target.ref;
        if (isEnumMember(target)) return target.name;
        if (isParameter(target)) return undefined; // role is passed in from outside
    }
    return undefined;
}


/**
 * Parameter domains from `versions(when: …)`: the `and`-connected parts of the condition of the form
 * `name in a .. b` or `name in {…}`. Maps parameter name to the domain expression.
 */
export function versionDomains(item: Item): Map<string, Expression> {
    const domains = new Map<string, Expression>();
    const statement = item.body.find(s => builtinElementOf(s) === 'versions');
    const when = isContentStatement(statement) && isReference(statement.expression) ? statement.expression.arguments[0] : undefined;
    const visit = (e: Expression | undefined): void => {
        if (isBinaryExpression(e) && e.operator === 'and') {
            visit(e.left);
            visit(e.right);
        } else if (isBinaryExpression(e) && e.operator === 'in' && isReference(e.left) && isParameter(e.left.target.ref)
            && e.left.target.ref.$container === item && (isRangeExpression(e.right) || isSetLiteral(e.right))
            && !domains.has(e.left.target.ref.name)) {
            domains.set(e.left.target.ref.name, e.right);
        }
    };
    if (when && isValueArgument(when)) visit(when.value);
    return domains;
}
