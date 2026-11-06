import { AstUtils, GrammarUtils, UriUtils, type AstNode, type LangiumDocument, type ValidationAcceptor } from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import {
    BUNDLE_FORMAT, BUNDLE_VERSION,
    type BookletDef, type Bundle, type CaseDef, type CodingDef, type ComponentDef, type ElementNode, type Expr, type ItemDef, type PartDef,
    type FeedbackDef, type ItemParamDef, type Node, type RuleFeedback, type Src
} from '@answerfield/bundle';
import { EvalError, evaluate, itemVersions, iterate, toJson, isVersion, defaultParams } from '@answerfield/expr';
import { MEDIA_PARAMETERS, optionComparison, optionNumber, resolvePlaceholder, templateOf, type Placeholder, ast, previewSource, versionDomains, builtinCallOf, builtinElementOf, isMediaPath, isScoreRule, itemRefOf, renderMath, bindingsOf, matchArguments, printType, ruleSources, type ItemServices } from '@answerfield/language';

type AstExpression = ast.Expression;

/** Options for `compileDocument`. */
export interface CompileOptions {
    /** Dev bundle: source reference on every node, error placeholders instead of aborting. */
    dev?: boolean;
    /** Omit practice feedback (test delivery); included by default. */
    noFeedback?: boolean;
    /** Document whose nodes get IDs and which is source 0 (dev); default: the compiled document. */
    focus?: LangiumDocument;
}

/** Bundle plus everything a host needs to report errors, watch files and store assets. */
export interface CompileResult {
    bundle: Bundle;
    /** Errors that appear as placeholders in a dev bundle or block a release build. */
    errors: CompileError[];
    /** URIs of all documents involved (checked before a release build). */
    documents: string[];
    /** Media: bundle path → source file URI (for hashing and storage, see `af compile --assets`). */
    assets: Record<string, string>;
}

/** Compile error, optionally attached to the AST node it refers to. */
export class CompileError extends Error {
    constructor(message: string, readonly node?: AstNode) {
        super(message);
    }
}

/**
 * Coding functions the compiler emits as `meta` expressions with the names of response variables, not their values;
 * the entries of the catalog in `@answerfield/bundle` whose `form` is `meta`.
 */
export const META_FUNCTIONS: ReadonlySet<string> = new Set(['changed', 'displayed', 'sum_score']);

/**
 * Built-ins of `prelude.af` the compiler resolves into bundle structure, so their names never reach a bundle and the
 * catalog in `@answerfield/bundle` does not list them: `show` becomes a `ShowNode`, `variant` the variants of the
 * enclosing element, `versions`, `deny` and `allow` fields of the item or booklet, `part` and `instruction` parts and
 * instruction pages, `correct`, `codes` and `code` coding cases, `manual` an `op: 'manual'` condition. Every other
 * built-in is a catalog entry.
 */
export const RESOLVED_BUILTINS: ReadonlySet<string> = new Set([
    'show', 'variant', 'versions', 'deny', 'allow', 'part', 'instruction', 'manual', 'correct', 'codes', 'code'
]);

/**
 * Compiles all items of a document (including items referenced by its booklets) with their codings and all
 * components they use. The document must be built (DocumentState.Validated).
 */
export function compileDocument(services: ItemServices, document: LangiumDocument, options: CompileOptions = {}): CompileResult {
    return new Compiler(services, options).compile(document);
}

/** URI scheme of the in-memory preview document for component files (never part of the workspace). */
export const PREVIEW_SCHEME = 'af-preview';

/**
 * Dev bundle for the editor. A document without items and booklets but with components gets one preview item per
 * component: it calls the component with sample arguments and carries the component's ID, so the visual editor works
 * on the component (palette into its body, signature in the form). The preview document is parsed and linked in
 * memory only: no diagnostics, invisible to other documents.
 */
export async function compileForEditor(services: ItemServices, document: LangiumDocument): Promise<CompileResult> {
    const root = document.parseResult.value as ast.Document;
    const components = root.elements.filter(ast.isComponent);
    if (root.elements.some(e => ast.isItem(e) || ast.isBooklet(e)) || components.length === 0) {
        return compileDocument(services, document, { dev: true });
    }
    const uri = document.uri.with({ scheme: PREVIEW_SCHEME });
    const preview = services.shared.workspace.LangiumDocumentFactory.fromString<ast.Document>(previewSource(services, components), uri);
    preview.localSymbols = await services.references.ScopeComputation.collectLocalSymbols(preview);
    await services.references.Linker.link(preview);
    const result = new Compiler(services, { dev: true, focus: document }).compile(preview);
    const locator = services.workspace.AstNodeLocator;
    result.bundle.items.forEach((item, i) => {
        // shown as the component (a preview tab for "Sterne"), edited as the component
        item.name = components[i].name;
        item.title = 'Vorschau';
        item.id = locator.getAstNodePath(components[i]);
        const cst = components[i].$cstNode;
        if (cst) item.src = [0, cst.offset, cst.end];
    });
    result.documents = result.documents.filter(d => !d.startsWith(`${PREVIEW_SCHEME}:`));
    return result;
}

/**
 * Registers checks only the compiler can compute (versions: do any exist, do the defaults form one, not too many
 * combinations) as ordinary validation rules, so they show up in the editor and in `af check`, not only at release.
 * The language package does not know the compiler; hosts that have one (language server, CLI) register them here.
 */
export function registerCompilerChecks(services: ItemServices): void {
    const report = (errors: CompileError[], fallback: AstNode, accept: ValidationAcceptor) =>
        errors.forEach(e => accept('error', e.message, { node: e.node ?? fallback }));
    services.validation.ValidationRegistry.register({
        Item: (item: ast.Item, accept: ValidationAcceptor) => report(new Compiler(services, {}).versionProblems(item), item, accept),
        Booklet: (booklet: ast.Booklet, accept: ValidationAcceptor) => report(new Compiler(services, {}).versionProblems(booklet), booklet, accept)
    });
}

class Compiler {
    protected readonly sources: string[] = [];
    protected readonly components: Record<string, ComponentDef> = {};
    protected readonly errors: CompileError[] = [];
    protected readonly errorOffsets = new Map<string, Array<{ offset: number; message: string }>>();

    constructor(protected readonly services: ItemServices, protected readonly options: CompileOptions) { }

    protected main?: LangiumDocument;

    protected readonly documents = new Set<string>();
    protected readonly items: ItemDef[] = [];
    protected readonly assets = new Map<string, string>();

    compile(document: LangiumDocument): CompileResult {
        this.main = this.options.focus ?? document;
        this.documents.add(this.main.uri.toString());
        // The edited document is always source 0
        if (this.options.dev) this.sources.push(this.main.uri.toString());
        const root = document.parseResult.value as ast.Document;
        const booklets = root.elements.filter(ast.isBooklet);
        // Items of the document and of all its booklets (possibly from other files)
        const items = [...root.elements.filter(ast.isItem)];
        for (const booklet of booklets) {
            for (const node of AstUtils.streamAllContents(booklet)) {
                const item = itemRefOf(node);
                if (item && !items.includes(item)) items.push(item);
            }
        }
        const codings = this.services.shared.workspace.LangiumDocuments.all
            .flatMap(d => (d.parseResult.value as ast.Document).elements.filter(ast.isCoding))
            .filter(c => items.includes(c.item.ref as ast.Item))
            .toArray();
        // Order by item, not by file load order, so the bundle is deterministic
        codings.sort((a, b) => items.indexOf(a.item.ref as ast.Item) - items.indexOf(b.item.ref as ast.Item));
        // Codings from other files count as involved documents (revalidation, preview)
        codings.forEach(c => this.documents.add(AstUtils.getDocument(c).uri.toString()));

        this.items.push(...items.map(item => this.item(item)));
        const bookletDefs = booklets.map(b => this.booklet(b));
        const bundle: Bundle = {
            format: BUNDLE_FORMAT,
            version: BUNDLE_VERSION,
            items: this.items,
            ...(bookletDefs.length > 0 ? { booklets: bookletDefs } : {}),
            components: this.components,
            codings: codings.map(coding => this.coding(coding))
        };
        const feedback = this.options.noFeedback ? [] : codings.map(coding => this.feedback(coding)).filter((f): f is FeedbackDef => f !== undefined);
        if (feedback.length > 0) bundle.feedback = feedback;
        if (this.assets.size > 0) {
            bundle.assets = Object.fromEntries([...this.assets.keys()].sort().map(k => [k, {}]));
        }
        if (this.options.dev) {
            bundle.dev = true;
            bundle.sources = this.sources;
        }
        return { bundle, errors: this.errors, documents: [...this.documents], assets: Object.fromEntries(this.assets) };
    }

    /**
     * Maps a relative media path to its bundle path (relative to the compiled file, even for items from other
     * folders) and records the asset. URLs with a scheme are kept as is.
     */
    protected media(expr: ast.Expression): Expr {
        if (!ast.isStringLiteral(expr) || expr.value === '' || /^[a-z][\w+.-]*:/i.test(expr.value)) {
            return ast.isStringLiteral(expr) ? { op: 'lit', value: expr.value } : this.expression(expr);
        }
        const file = UriUtils.joinPath(UriUtils.dirname(AstUtils.getDocument(expr).uri), expr.value);
        const key = this.main ? UriUtils.relative(UriUtils.dirname(this.main.uri), file) : expr.value;
        this.assets.set(key, file.toString());
        return { op: 'lit', value: key };
    }

    // --- Booklets ----------------------------------------------------------------------

    protected booklet(booklet: ast.Booklet): BookletDef {
        const accommodations = this.collect(() => this.rules(booklet.body, this.versionsCondition(booklet.body), [], booklet));
        const parts = booklet.body.filter((s): s is ast.ContentStatement => builtinElementOf(s) === 'part');
        return {
            name: booklet.name,
            ...(booklet.title !== undefined ? { title: booklet.title } : {}),
            ...(accommodations ? { accommodations } : {}),
            parts: parts.map((part, index) => this.part(booklet, part, index + 1)),
            ...this.src(booklet)
        };
    }

    /** `part("Title", time: 20min, navigation: forward) { item1  instruction("…") { … } }` */
    protected part(booklet: ast.Booklet, part: ast.ContentStatement, number: number): PartDef {
        const name = `teil${number}`;
        const title = this.argument(part, 'title');
        const time = this.argument(part, 'time');
        const navigation = this.argument(part, 'navigation');
        const start = this.argument(part, 'start');
        const entries = part.body.flatMap((entry, index) => {
            const item = itemRefOf(entry);
            if (item) return [item.name];
            if (builtinElementOf(entry) !== 'instruction') return [];
            // An instruction page becomes an item without responses
            const instruction = entry as ast.ContentStatement;
            const id = `${booklet.name}.${name}.${index + 1}`;
            const heading = this.argument(instruction, 'title');
            this.items.push({
                name: id, instruction: true,
                ...(ast.isStringLiteral(heading) ? { title: heading.value } : {}),
                body: this.statements(instruction.body),
                variables: [],
                ...this.src(instruction)
            });
            return [id];
        });
        return {
            name,
            ...(ast.isStringLiteral(title) ? { title: title.value } : {}),
            ...(time ? { time: this.seconds(time) } : {}),
            navigation: navigation && ast.isReference(navigation) && navigation.target.$refText === 'forward' ? 'forward' : 'free',
            ...(start && ast.isReference(start) && start.target.$refText === 'released' ? { start: 'released' as const } : {}),
            entries,
            ...this.src(part)
        };
    }

    /** Argument of an element call, named or positional. */
    protected argument(statement: ast.ContentStatement, param: string): AstExpression | undefined {
        return ast.isReference(statement.expression)
            ? matchArguments(statement.expression)?.matches.find(m => m.parameter.name === param)?.argument.value : undefined;
    }

    /** Version errors of an item or booklet (for `registerCompilerChecks`). */
    versionProblems(node: ast.Item | ast.Booklet): CompileError[] {
        const when = this.versionsCondition(node.body);
        const params = ast.isItem(node) ? this.collect(() => this.params(node)) ?? [] : [];
        this.collect(() => this.rules(node.body, when, params, node));
        return this.errors;
    }

    /** Condition from `versions(when: …)` in the body of an item or booklet. */
    protected versionsCondition(body: ast.Statement[]): AstExpression | undefined {
        const statement = body.find(s => builtinElementOf(s) === 'versions') as ast.ContentStatement | undefined;
        return statement ? this.argument(statement, 'when') : undefined;
    }

    /**
     * Accommodation rules of an item or booklet: `deny(…)` with its reason, `allow(…)`, plus accommodations under which
     * no version satisfies `versions(when: …)`.
     */
    protected rules(body: ast.Statement[], when: AstExpression | undefined, params: ItemParamDef[], node: AstNode): ItemDef['accommodations'] {
        const derived = when || params.length > 0 ? this.accommodations(when, params, node) : undefined;
        const denyStatement = body.find(s => builtinElementOf(s) === 'deny') as ast.ContentStatement | undefined;
        const allowStatement = body.find(s => builtinElementOf(s) === 'allow') as ast.ContentStatement | undefined;
        const deny = new Set([...derived?.deny ?? [], ...this.accommodationSet(denyStatement)]);
        const allow = this.accommodationSet(allowStatement);
        const reason = denyStatement && this.argument(denyStatement, 'reason');
        if (deny.size === 0 && allow.length === 0) return undefined;
        return {
            allow: this.accommodationNames().filter(a => allow.includes(a)),
            deny: this.accommodationNames().filter(a => deny.has(a)),
            ...(ast.isStringLiteral(reason) && deny.size > 0 ? { reason: reason.value } : {})
        };
    }

    /** The set of accommodations given to `deny` or `allow`, as names. */
    protected accommodationSet(statement: ast.ContentStatement | undefined): string[] {
        const expr = statement && this.argument(statement, 'accommodations');
        if (!expr) return [];
        try {
            const value = evaluate(this.expression(expr), { lookup: name => { throw new EvalError(`'${name}' ist hier nicht bekannt; Anpassungen stehen als feste Menge, z. B. {read_aloud, simple_language}.`); } });
            return iterate(value).map(v => String(toJson(v)));
        } catch (error) {
            throw new CompileError(error instanceof Error ? error.message : String(error), expr);
        }
    }

    /**
     * Derives permitted accommodations from the condition: an accommodation under which no version satisfies it is
     * denied. Also checks that versions exist and that the parameter defaults form one.
     */
    protected accommodations(when: AstExpression | undefined, params: ItemParamDef[], node: AstNode): { allow: string[]; deny: string[] } | undefined {
        if (!when) return undefined;
        const probe: ItemDef = { name: '', body: [], variables: [], params, versions: this.expression(when) };
        let base;
        try {
            base = itemVersions(probe, [], 1);
        } catch (e) {
            throw new CompileError(e instanceof Error ? e.message : String(e), when);
        }
        if (base.length === 0) throw new CompileError('Keine Fassung erfüllt die Bedingung.', when);
        if (params.length > 0 && !isVersion(probe, defaultParams(probe))) {
            throw new CompileError('Die Standardwerte der Parameter erfüllen die Bedingung nicht.', node);
        }
        // Only a condition that mentions accommodations can exclude any
        if (!mentions(probe.versions!, 'accommodations')) return undefined;
        const deny = this.accommodationNames().filter(a => itemVersions(probe, [a], 1).length === 0);
        return deny.length > 0 ? { allow: [], deny } : undefined;
    }

    private accommodationCache?: string[];

    /** Members of `enum Accommodation` from the prelude. */
    protected accommodationNames(): string[] {
        return this.accommodationCache ??= this.findAccommodationNames();
    }

    private findAccommodationNames(): string[] {
        const decl = this.services.shared.workspace.LangiumDocuments.all
            .flatMap(d => (d.parseResult.value as ast.Document).elements)
            .find((e): e is ast.EnumDecl => ast.isEnumDecl(e) && e.name === 'Accommodation');
        return decl?.members.map(m => m.name) ?? [];
    }

    /** Item parameters with default and domain (a Bool without a domain takes both values). */
    protected params(item: ast.Item): ItemParamDef[] {
        const domains = versionDomains(item);
        const constant = (e: AstExpression) => {
            try {
                return evaluate(this.expression(e), { lookup: name => { throw new EvalError(`'${name}' ist hier nicht bekannt; Wertebereiche und Standardwerte sind feste Werte.`); } });
            } catch (error) {
                throw new CompileError(error instanceof Error ? error.message : String(error), e);
            }
        };
        return item.parameters.map(p => {
            const type = printType(this.types.declaredType(p.type));
            const domain = domains.get(p.name);
            const values = domain ? iterate(constant(domain)).map(toJson) : type === 'Bool' ? [true, false] : [];
            return { name: p.name, type, default: p.defaultValue ? toJson(constant(p.defaultValue)) : null, values };
        });
    }

    protected seconds(expr: AstExpression): number {
        const m = ast.isDimensionLiteral(expr) ? /^([\d.]+)(ms|min|s)$/.exec(expr.value) : null;
        if (!m) {
            this.errors.push(new CompileError('Zeitlimit muss eine Dauer wie 20min sein.', expr));
            return 0;
        }
        const value = Number(m[1]);
        return m[2] === 'min' ? value * 60 : m[2] === 'ms' ? value / 1000 : value;
    }

    // --- Declarations ------------------------------------------------------------

    protected item(item: ast.Item): ItemDef {
        const params = this.collect(() => this.params(item)) ?? [];
        const when = this.versionsCondition(item.body);
        const accommodations = this.collect(() => this.rules(item.body, when, params, item));
        return {
            name: item.name,
            ...(item.title !== undefined ? { title: item.title } : {}),
            ...(accommodations ? { accommodations } : {}),
            ...(params.length > 0 ? { params, ...(when ? { versions: this.tryExpression(when) } : {}) } : {}),
            body: this.statements(item.body),
            // Only bindings to a call; while typing, `x = 5` may appear (the validator reports it)
            variables: bindingsOf(item).filter(b => ast.isReference(b.value)).map(b => ({
                id: b.name,
                type: printType(this.types.typeOfDeclaration(b)),
                component: (b.value as ast.Reference).target.$refText
            })),
            ...this.src(item)
        };
    }

    protected component(component: ast.Component): void {
        if (this.components[component.name]) return;
        // Register a placeholder first so cycles terminate
        const def: ComponentDef = { name: component.name, params: [], body: [] };
        this.components[component.name] = def;
        def.params = component.parameters.map(p => ({
            name: p.name,
            type: printType(this.types.declaredType(p.type)),
            ...(p.defaultValue ? { default: this.tryExpression(p.defaultValue) } : {}),
            ...(p.isState ? { state: true as const } : {})
        }));
        const response = this.types.responseType(component);
        if (response) def.response = printType(response);
        def.body = this.statements(component.body);
        Object.assign(def, this.src(component));
    }

    protected coding(coding: ast.Coding): CodingDef {
        return {
            item: coding.item.$refText,
            rules: coding.rules.filter(r => !isScoreRule(r)).map(rule => ({
                variable: rule.name,
                answers: ruleSources(rule).map(b => b.name),
                cases: this.cases(rule.value as ast.Reference)
            })),
            scores: coding.rules.filter(isScoreRule).map(s => ({ name: s.name, value: this.tryExpression(s.value) }))
        };
    }

    /** Practice feedback from the coding rules (`right`, `wrong`, `feedback`, `otherwise`, `hints`, `solution`). */
    protected feedback(coding: ast.Coding): FeedbackDef | undefined {
        const rules: Record<string, RuleFeedback> = {};
        for (const rule of coding.rules.filter(r => !isScoreRule(r))) {
            const call = rule.value as ast.Reference;
            const matches = matchArguments(call)?.matches ?? [];
            const arg = (ref: ast.Reference, name: string) => matchArguments(ref)?.matches.find(m => m.parameter.name === name)?.argument.value;
            const expr = (e: ast.Expression | undefined) => e ? this.tryExpression(e) : undefined;
            const fb: RuleFeedback = {};
            const codes: Record<string, Expr> = {};
            if (builtinCallOf(call) === 'correct') {
                const right = expr(arg(call, 'right')), wrong = expr(arg(call, 'wrong'));
                if (right) codes['1'] = right;
                if (wrong) codes['0'] = wrong;
            } else {
                for (const c of matches.filter(m => m.parameter.name === 'cases').map(m => m.argument.value).filter(ast.isReference)) {
                    const code = arg(c, 'code'), text = expr(arg(c, 'feedback'));
                    if (ast.isNumberLiteral(code) && text) codes[String(code.value)] = text;
                }
                const otherwise = expr(arg(call, 'otherwise'));
                if (otherwise) fb.otherwise = otherwise;
            }
            if (Object.keys(codes).length > 0) fb.codes = codes;
            const hints = arg(call, 'hints');
            if (ast.isListLiteral(hints) && hints.elements.length > 0) fb.hints = hints.elements.map(h => this.tryExpression(h));
            const solution = expr(arg(call, 'solution'));
            if (solution) fb.solution = solution;
            if (Object.keys(fb).length > 0) rules[rule.name] = fb;
        }
        return Object.keys(rules).length > 0 ? { item: coding.item.$refText, rules } : undefined;
    }

    /**
     * Cases of a coding rule: `correct(c)` yields code 1 "richtig" with score 1; `codes(code(…), …)` its own codes.
     * If none matches, the coder yields code 0; unanswered responses get missing codes.
     */
    protected cases(call: ast.Reference): CaseDef[] {
        const arg = (ref: ast.Reference, name: string) => matchArguments(ref)?.matches.find(m => m.parameter.name === name)?.argument.value;
        if (builtinCallOf(call) === 'correct') {
            const when = arg(call, 'when');
            return [{ code: 1, label: 'richtig', score: 1, when: when ? this.tryExpression(when) : { op: 'lit', value: false } }];
        }
        return (matchArguments(call)?.matches ?? []).filter(m => m.parameter.name === 'cases').map(m => m.argument.value).filter(ast.isReference).map(c => {
            const code = arg(c, 'code'), label = arg(c, 'label'), score = arg(c, 'score'), when = arg(c, 'when');
            return {
                code: ast.isNumberLiteral(code) ? code.value : 0,
                ...(ast.isStringLiteral(label) ? { label: label.value } : {}),
                ...(ast.isNumberLiteral(score) ? { score: score.value } : {}),
                when: when ? this.tryExpression(when) : { op: 'lit', value: false }
            };
        });
    }

    /** `manual("criterion", yes: […], no: […])`: a question for the human coder; its ID combines rule name and criterion. */
    protected manual(ref: ast.Reference): Expr {
        const info = matchArguments(ref);
        const arg = (name: string) => info?.matches.find(m => m.parameter.name === name)?.argument.value;
        const texts = (e: ast.Expression | undefined): string[] =>
            ast.isListLiteral(e) ? e.elements.filter(ast.isStringLiteral).map(l => l.value) : [];
        const criterion = arg('criterion');
        if (!ast.isStringLiteral(criterion)) throw new CompileError("'manual' erwartet das Kriterium als Text.", ref);
        const rule = AstUtils.getContainerOfType(ref, ast.isCodingRule);
        if (!rule) throw new CompileError("'manual' ist nur in Kodierungen erlaubt.", ref);
        const about = arg('about');
        const answers = ast.isListLiteral(about)
            ? about.elements.filter(ast.isReference).map(r => r.target.$refText)
            : [];
        return {
            op: 'manual', question: {
                id: `${rule.name}: ${criterion.value}`, criterion: criterion.value, yes: texts(arg('yes')), no: texts(arg('no')),
                ...(answers.length > 0 ? { answers } : {})
            }
        };
    }

    // --- Statements ------------------------------------------------------------------

    protected statements(statements: ast.Statement[]): Node[] {
        return statements.flatMap(s => {
            const direct = this.directErrors(s);
            if (direct.length > 0) {
                return [this.errorNode(direct[0], s)];
            }
            try {
                return this.statement(s);
            } catch (e) {
                if (e instanceof CompileError) return [this.errorNode(e.message, e.node ?? s)];
                throw e;
            }
        });
    }

    protected statement(s: ast.Statement): Node[] {
        switch (s.$type) {
            case 'StateDecl': {
                const state = s as ast.StateDecl;
                return [{ kind: 'state', name: state.name, type: printType(this.types.declaredType(state.type)), init: this.expression(state.initial) }];
            }
            case 'LetDecl': {
                const decl = s as ast.LetDecl;
                return [{ kind: 'let', name: decl.name, value: this.expression(decl.value) }];
            }
            case 'ForStatement': {
                const loop = s as ast.ForStatement;
                return [{ kind: 'for', vars: loop.variables.map(v => v.name), iterable: this.expression(loop.iterable), body: this.statements(loop.body), ...this.src(loop) }];
            }
            case 'ChildrenStatement':
                return [{ kind: 'children' }];
            case 'ResponseStatement':
                return [{ kind: 'response', value: this.expression((s as ast.ResponseStatement).value) }];
            case 'Binding': {
                const binding = s as ast.Binding;
                const call = binding.value as ast.Reference;
                return [this.componentCall(call, binding.name, binding)];
            }
            case 'ContentStatement': {
                const statement = s as ast.ContentStatement;
                // Versions and rules belong to the item, variants to the enclosing element; none produces a node
                const element = builtinElementOf(statement);
                if (element === 'versions' || element === 'variant' || element === 'deny' || element === 'allow') return [];
                if (element === 'show') {
                    const when = this.argument(statement, 'when');
                    return [{ kind: 'show', when: when ? this.expression(when) : { op: 'lit', value: false }, body: this.statements(statement.body), ...this.src(statement) }];
                }
                // `mark("her") " after"` or `"one" "two"`: text after something that takes no content is separate content
                const target = ast.isReference(statement.expression) ? statement.expression.target.ref : undefined;
                const takesContent = ast.isElementDecl(target) || (ast.isComponent(target) && target.acceptsChildren);
                const trailing = statement.text !== undefined && !takesContent
                    ? [{ kind: 'content', value: this.text(statement, statement.text) } satisfies Node] : [];
                return [this.content(statement), ...trailing];
            }
        }
        throw new CompileError(`Unbekannte Anweisung ${(s as AstNode).$type}`, s);
    }

    protected content(statement: ast.ContentStatement): Node {
        const expr = statement.expression;
        const target = ast.isReference(expr) ? expr.target.ref : undefined;
        if (ast.isReference(expr) && ast.isElementDecl(target)) {
            return this.element(expr, target, statement);
        }
        if (ast.isReference(expr) && ast.isComponent(target)) {
            return this.componentCall(expr, undefined, statement);
        }
        return { kind: 'content', value: this.expression(expr), ...this.src(statement) };
    }

    protected element(ref: ast.Reference, decl: ast.ElementDecl, statement: ast.ContentStatement): ElementNode {
        const info = matchArguments(ref);
        const args: Record<string, Expr> = {};
        let bind: string | undefined;
        let bindIndex: Expr | undefined;
        for (const param of decl.parameters) {
            const match = info?.matches.find(m => m.parameter === param);
            if (param.name === 'bind') {
                let value = match?.argument.value;
                if (ast.isIndexAccess(value)) {
                    bindIndex = this.expression(value.index);
                    value = value.receiver;
                }
                if (value) bind = (value as ast.Reference).target.$refText;
                continue;
            }
            const media = MEDIA_PARAMETERS.has(`${decl.name}.${param.name}`);
            args[param.name] = match
                ? (media ? this.media(match.argument.value) : this.expression(match.argument.value))
                : param.defaultValue ? this.expression(param.defaultValue) : { op: 'lit', value: null };
        }
        // Several handlers for the same event run their actions in order
        const on: Record<string, Array<{ state: string; value: Expr }>> = {};
        for (const handler of ref.arguments.filter(ast.isHandler)) {
            (on[handler.event.$refText] ??= []).push({ state: handler.action.target.$refText, value: this.expression(handler.action.value) });
        }
        // `variant(simple_language) "…"` or `variant(easy_language) { … }` in the body: variants of this element, keyed by accommodation
        const variants: Record<string, Expr> = {};
        const replacements: Record<string, Node[]> = {};
        for (const v of statement.body.filter((s): s is ast.ContentStatement => builtinElementOf(s) === 'variant')) {
            const kind = this.argument(v, 'kind');
            // A language level given as a block replaces the children (several paragraphs, markup)
            if (ast.isReference(kind) && ['simple_language', 'easy_language'].includes(kind.target.$refText) && v.text === undefined) {
                replacements[kind.target.$refText] = this.statements(v.body);
                continue;
            }
            const content = v.text !== undefined ? undefined : v.body.find(ast.isContentStatement)?.expression;
            const value: Expr = v.text !== undefined ? this.text(v, v.text) : content ? this.expression(content) : { op: 'lit', value: null };
            if (ast.isReference(kind)) variants[kind.target.$refText] = value;
        }
        const children = statement.text !== undefined
            ? [{ kind: 'content', value: this.text(statement, statement.text) } satisfies Node]
            : this.statements(statement.body);
        return {
            kind: 'element',
            element: decl.name,
            args,
            ...(bind ? { bind } : {}),
            ...(bindIndex ? { bindIndex } : {}),
            ...(Object.keys(on).length > 0 ? { on } : {}),
            children,
            ...(Object.keys(variants).length > 0 ? { variants } : {}),
            ...(Object.keys(replacements).length > 0 ? { replacements } : {}),
            ...this.src(statement)
        };
    }

    protected componentCall(ref: ast.Reference, binding: string | undefined, source: AstNode): Node {
        const component = ref.target.ref;
        if (!ast.isComponent(component)) {
            throw new CompileError(`'${ref.target.$refText}' ist keine Komponente.`, ref);
        }
        this.component(component);
        const args: Record<string, Expr> = {};
        const binds: Record<string, { state: string; index?: Expr }> = {};
        for (const { argument, parameter } of matchArguments(ref)?.matches ?? []) {
            if (parameter.isState) {
                // State parameter: bound to the caller's `state` or `list[i]`
                const value = argument.value;
                const target = ast.isIndexAccess(value) ? value.receiver : value;
                binds[parameter.name] = {
                    state: (target as ast.Reference).target.$refText,
                    ...(ast.isIndexAccess(value) ? { index: this.expression(value.index) } : {})
                };
                continue;
            }
            args[parameter.name] = this.expression(argument.value);
        }
        // Content of the call: `Message(…) { … }` or the short form `Message(…) "Text"`
        let children: Node[] | undefined;
        if (component.acceptsChildren && ast.isContentStatement(source)) {
            children = source.text !== undefined
                ? [{ kind: 'content', value: this.text(source, source.text) }]
                : this.statements(source.body);
        }
        return {
            kind: 'component', component: component.name, args, ...(binding ? { binding } : {}),
            ...(Object.keys(binds).length > 0 ? { binds } : {}),
            ...(children ? { children } : {}), ...this.src(source)
        };
    }

    // --- Expressions ------------------------------------------------------------------

    /** Result of `fn`; a CompileError is recorded and yields undefined. */
    protected collect<T>(fn: () => T): T | undefined {
        try {
            return fn();
        } catch (e) {
            if (!(e instanceof CompileError)) throw e;
            this.errors.push(e);
            return undefined;
        }
    }

    protected tryExpression(expr: AstExpression): Expr {
        try {
            return this.expression(expr);
        } catch (e) {
            if (e instanceof CompileError) {
                this.errors.push(e);
                return { op: 'lit', value: null };
            }
            throw e;
        }
    }

    /**
     * Upper bound on the size of compiled expressions: user functions are inlined, and nested inlining otherwise
     * grows exponentially (16 levels would yield a 10 MB bundle).
     */
    protected expressionBudget = 500_000;

    protected expression(expr: AstExpression): Expr {
        if (--this.expressionBudget < 0) {
            throw new CompileError('Der Ausdruck wird beim Übersetzen zu groß: Eigene Funktionen sind zu oft ineinander eingesetzt.', expr);
        }
        // The number's own token: the node's text may include an opening parenthesis, e.g. the x of (3 | 4)
        if (ast.isNumberLiteral(expr)) {
            const token = expr.$cstNode && GrammarUtils.findNodeForProperty(expr.$cstNode, 'value');
            return { op: 'lit', value: { num: token?.text ?? String(expr.value) } };
        }
        if (ast.isDimensionLiteral(expr)) return { op: 'lit', value: { size: expr.value } };
        // Relative media path (e.g. passed through a component to image): collect as an asset
        if (ast.isStringLiteral(expr)) return isMediaPath(expr.value) ? this.media(expr) : this.text(expr, expr.value);
        if (ast.isBooleanLiteral(expr)) return { op: 'lit', value: expr.value };
        if (ast.isNoneLiteral(expr)) return { op: 'lit', value: null };
        if (ast.isSetLiteral(expr)) return { op: 'set', items: expr.elements.map(e => this.expression(e)) };
        if (ast.isListLiteral(expr)) return { op: 'list', items: expr.elements.map(e => this.expression(e)) };
        if (ast.isPointLiteral(expr)) return { op: 'call', fn: 'point', args: [this.expression(expr.x), this.expression(expr.y)] };
        if (ast.isIfExpression(expr)) return { op: 'if', cond: this.expression(expr.condition), then: this.expression(expr.then), else: this.expression(expr.else) };
        if (ast.isUnaryExpression(expr)) return { op: 'un', operator: expr.operator, operand: this.expression(expr.operand) };
        if (ast.isBinaryExpression(expr)) {
            // Option texts of a choice become its option numbers
            const byText = optionComparison(expr);
            const side = (e: AstExpression, own: boolean): Expr => {
                if (!own || !byText) return this.expression(e);
                const number = (t: ast.StringLiteral): Expr => ({ op: 'lit', value: { num: String(optionNumber(byText.options, t.value) ?? 0) } });
                return ast.isSetLiteral(e) ? { op: 'set', items: byText.texts.map(number) } : number(byText.texts[0]);
            };
            return { op: 'bin', operator: expr.operator, left: side(expr.left, byText?.side === 'left'), right: side(expr.right, byText?.side === 'right') };
        }
        if (ast.isRangeExpression(expr)) return { op: 'range', from: this.expression(expr.from), to: this.expression(expr.to) };
        if (ast.isMemberAccess(expr)) return { op: 'member', target: this.expression(expr.receiver), name: expr.member };
        if (ast.isIndexAccess(expr)) return { op: 'index', target: this.expression(expr.receiver), index: this.expression(expr.index) };
        if (ast.isReference(expr)) return this.reference(expr);
        throw new CompileError(`Ausdruck ${(expr as AstNode).$type} wird nicht unterstützt.`, expr);
    }

    /** A text, with its placeholders ("Reihe {r}") as a concatenation; a plain text stays a literal. */
    protected text(node: AstNode, text: string): Expr {
        const parts = templateOf(node, text);
        if (!parts) return { op: 'lit', value: text };
        const exprs = parts.map((part): Expr => typeof part === 'string' ? { op: 'lit', value: part } : this.placeholder(node, part));
        // Start with text so that "+" concatenates even if the text begins with a number placeholder
        return exprs.reduce((left, right) => ({ op: 'bin', operator: '+', left, right }), { op: 'lit', value: '' } as Expr);
    }

    protected placeholder(node: AstNode, part: Placeholder): Expr {
        const target = resolvePlaceholder(this.services.references.ScopeProvider, node, part.path[0]);
        if (!target) throw new CompileError(`Platzhalter {${part.path.join('.')}}: '${part.path[0]}' ist hier nicht bekannt.`, node);
        const ref = { $type: 'Reference', $container: node, isCall: false, arguments: [], target: { ref: target, $refText: part.path[0] } } as unknown as ast.Reference;
        return part.path.slice(1).reduce<Expr>((target, name) => ({ op: 'member', target, name }), this.reference(ref));
    }

    protected reference(ref: ast.Reference): Expr {
        const target = ref.target.ref;
        if (!target) throw new CompileError(`'${ref.target.$refText}' ist nicht bekannt.`, ref);
        if (ast.isEnumMember(target)) return { op: 'enum', value: target.name };
        if (ast.isFunctionDecl(target)) {
            if (META_FUNCTIONS.has(target.name)) {
                return { op: 'meta', fn: target.name, vars: ref.arguments.map(a => metaVariable(a)) };
            }
            if (target.name === 'manual') return this.manual(ref);
            if (target.name === 'math') {
                // Render LaTeX to MathML at compile time so the runtime needs no math library
                const tex = matchArguments(ref)?.matches[0]?.argument.value;
                if (!ast.isStringLiteral(tex)) throw new CompileError('Formel als festen Text angeben.', ref);
                try {
                    return { op: 'call', fn: 'math', args: [{ op: 'lit', value: renderMath(tex.value) }, { op: 'lit', value: tex.value }] };
                } catch (e) {
                    throw new CompileError(`Formel: ${e instanceof Error ? e.message : String(e)}`, tex);
                }
            }
            if (target.body) return this.inline(ref, target);
            const info = matchArguments(ref);
            const args: Expr[] = [];
            for (const param of target.parameters) {
                const matches = info?.matches.filter(m => m.parameter === param) ?? [];
                if (matches.length > 0) {
                    const media = MEDIA_PARAMETERS.has(`${target.name}.${param.name}`);
                    args.push(...matches.map(m => (media ? this.media(m.argument.value) : this.expression(m.argument.value))));
                } else if (!param.variadic) {
                    args.push(param.defaultValue ? this.expression(param.defaultValue) : { op: 'lit', value: null });
                }
            }
            return { op: 'call', fn: target.name, args };
        }
        if (ast.isComponent(target) || ast.isElementDecl(target)) {
            throw new CompileError(`'${target.name}' ist kein Wert; Elemente und Komponenten stehen als eigene Anweisung.`, ref);
        }
        // Parameter of a user function: replaced by the call's argument
        const bound = ast.isParameter(target) ? this.inlined.at(-1)?.get(target) : undefined;
        if (bound) return bound;
        return { op: 'ref', name: ref.target.$refText };
    }

    /** Arguments of the user functions currently being inlined (innermost last). */
    protected readonly inlined: Array<Map<ast.Parameter, Expr>> = [];

    /**
     * Inlines a user function: its body replaces the call, parameters replaced by the arguments. The bundle only knows
     * built-in functions; the validator rules out recursion.
     */
    protected inline(ref: ast.Reference, fn: ast.FunctionDecl): Expr {
        if (this.inlined.length > 64) throw new CompileError(`Funktion '${fn.name}' ist zu tief verschachtelt.`, ref);
        const info = matchArguments(ref);
        const args = new Map<ast.Parameter, Expr>();
        for (const param of fn.parameters) {
            const match = info?.matches.find(m => m.parameter === param);
            args.set(param, match ? this.expression(match.argument.value)
                : param.defaultValue ? this.expression(param.defaultValue) : { op: 'lit', value: null });
        }
        this.inlined.push(args);
        try {
            return this.expression(fn.body!);
        } finally {
            this.inlined.pop();
        }
    }

    // --- Source references and errors -------------------------------------------------------

    protected get types() {
        return this.services.types.TypeSystem;
    }

    protected src(node: AstNode): { src?: Src; id?: string } {
        if (node.$cstNode) this.documents.add(AstUtils.getDocument(node).uri.toString());
        if (!this.options.dev || !node.$cstNode) return {};
        const document = AstUtils.getDocument(node);
        const uri = document.uri.toString();
        let index = this.sources.indexOf(uri);
        if (index < 0) index = this.sources.push(uri) - 1;
        const src: Src = [index, node.$cstNode.offset, node.$cstNode.end];
        // Only nodes of the edited document are selectable in the visual editor
        return document === this.main ? { src, id: this.services.workspace.AstNodeLocator.getAstNodePath(node) } : { src };
    }

    protected errorNode(message: string, node: AstNode): Node {
        this.errors.push(new CompileError(message, node));
        return { kind: 'error', message, ...this.src(node) };
    }

    /** Error messages located directly in this statement, not in nested statements. */
    protected directErrors(statement: ast.Statement): string[] {
        const cst = statement.$cstNode;
        if (!cst) return [];
        const errors = this.documentErrors(AstUtils.getDocument(statement));
        const nested = AstUtils.streamAllContents(statement).filter(ast.isStatement).map(n => n.$cstNode).nonNullable().toArray();
        return errors
            .filter(e => e.offset >= cst.offset && e.offset < cst.end)
            .filter(e => !nested.some(n => e.offset >= n.offset && e.offset < n.end))
            .map(e => e.message);
    }

    protected documentErrors(document: LangiumDocument): Array<{ offset: number; message: string }> {
        const key = document.uri.toString();
        let errors = this.errorOffsets.get(key);
        if (!errors) {
            errors = (document.diagnostics ?? [])
                .filter((d: Diagnostic) => d.severity === 1)
                .map((d: Diagnostic) => ({ offset: document.textDocument.offsetAt(d.range.start), message: typeof d.message === 'string' ? d.message : d.message.value }));
            this.errorOffsets.set(key, errors);
        }
        return errors;
    }
}

function metaVariable(argument: ast.Argument): string {
    if (ast.isValueArgument(argument) && ast.isReference(argument.value) && !argument.value.isCall) {
        return argument.value.target.$refText;
    }
    throw new CompileError('Erwartet den Namen einer Antwort.', argument);
}

/** Whether the expression calls `fn` anywhere. */
function mentions(expr: Expr, fn: string): boolean {
    const visit = (v: unknown): boolean => {
        if (Array.isArray(v)) return v.some(visit);
        if (!v || typeof v !== 'object') return false;
        const o = v as Record<string, unknown>;
        if (o.op === 'call' && o.fn === fn) return true;
        return Object.values(o).some(visit);
    };
    return visit(expr);
}
