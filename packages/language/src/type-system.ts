import { AstUtils, WorkspaceCache, type AstNode, type LangiumDocuments, type IndexManager, type AstNodeLocator } from 'langium';
import {
    EnumDecl,
    isBinaryExpression, isBinding, isBooleanLiteral, isCodingRule, isComponent, isDimensionLiteral, isElementDecl,
    isEnumMember, isForVariable, isFunctionDecl, isIfExpression, isIndexAccess, isLetDecl, isListLiteral, isMemberAccess, isPointLiteral,
    isNoneLiteral, isNumberLiteral, isParameter, isRangeExpression, isReference, isSetLiteral, isStateDecl,
    isStringLiteral, isUnaryExpression, isValueArgument, isHandler,
    type Argument, type BinaryExpression, type Callable, type Component, type DimensionLiteral, type Expression,
    type ElementDecl, type ForStatement, type ForVariable, type FunctionDecl, type NumberLiteral, type Parameter, type Reference, type TypeReference,
    type ValueArgument
} from './generated/ast.js';
import { isScoreRule } from './item-scope.js';
import type { ItemServices } from './item-module.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Names of the built-in primitive types. */
export type PrimitiveName =
    | 'Int' | 'Rational' | 'Text' | 'Bool' | 'Content' | 'Size' | 'Duration' | 'Point' | 'Coding' | 'Code';

/** Static type of an expression or declaration. */
export type Type =
    | { kind: 'primitive'; name: PrimitiveName }
    | { kind: 'list'; element: Type }
    | { kind: 'set'; element: Type }
    /** List or set (only in signatures, e.g. size) */
    | { kind: 'collection'; element: Type }
    | { kind: 'interval'; element: Type }
    | { kind: 'optional'; inner: Type }
    | { kind: 'enum'; decl: EnumDecl }
    | { kind: 'param'; name: string }
    /** Type of `none` */
    | { kind: 'none' }
    /** Element type of empty literals (`{}`, `[]`); assignable to anything */
    | { kind: 'empty' }
    /** Unknown or erroneous; suppresses follow-up errors */
    | { kind: 'any' };

/** Built-in primitive types; with {@link GENERIC_TYPES} the base types of the catalog in `@answerfield/bundle`. */
export const PRIMITIVE_TYPES: readonly PrimitiveName[] = ['Int', 'Rational', 'Text', 'Bool', 'Content', 'Size', 'Duration', 'Point', 'Coding', 'Code'];

/** Built-in generic types with their type parameters; `Interval` alone means `Interval<Rational>`. */
export const GENERIC_TYPES: Readonly<Record<string, readonly string[]>> = { List: ['T'], Set: ['T'], Collection: ['T'], Interval: ['T'] };

const PRIMITIVES = new Set<PrimitiveName>(PRIMITIVE_TYPES);

/** Type constants and constructors. */
export const Types = {
    Int: prim('Int'), Rational: prim('Rational'), Text: prim('Text'), Bool: prim('Bool'),
    Content: prim('Content'), Size: prim('Size'), Duration: prim('Duration'), Point: prim('Point'),
    any: { kind: 'any' } as Type, none: { kind: 'none' } as Type, empty: { kind: 'empty' } as Type,
    list: (element: Type): Type => ({ kind: 'list', element }),
    set: (element: Type): Type => ({ kind: 'set', element }),
    optional: (inner: Type): Type => inner.kind === 'optional' || inner.kind === 'any' ? inner : { kind: 'optional', inner },
    interval: (element: Type): Type => ({ kind: 'interval', element })
};

function prim(name: PrimitiveName): Type {
    return { kind: 'primitive', name };
}

const NUMERIC_RANK: Partial<Record<PrimitiveName, number>> = { Int: 0, Rational: 1 };

/** True for Int and Rational. */
export function isNumeric(t: Type): boolean {
    return t.kind === 'primitive' && NUMERIC_RANK[t.name] !== undefined;
}

function isLenient(t: Type): boolean {
    return t.kind === 'any' || t.kind === 'param';
}

/** Renders a type in AF syntax, e.g. `List<Int>?`. */
export function printType(t: Type): string {
    switch (t.kind) {
        case 'primitive': return t.name;
        case 'list': return `List<${printType(t.element)}>`;
        case 'set': return `Set<${printType(t.element)}>`;
        case 'collection': return `Collection<${printType(t.element)}>`;
        case 'interval': return t.element.kind === 'primitive' && t.element.name === 'Rational' ? 'Interval' : `Interval<${printType(t.element)}>`;
        case 'optional': return `${printType(t.inner)}?`;
        case 'enum': return t.decl.name;
        case 'param': return t.name;
        case 'none': return 'none';
        case 'empty': return 'Never';
        case 'any': return 'unbekannt';
    }
}

/** True if a value of type `source` may be used where `target` is expected. */
export function isAssignable(source: Type, target: Type): boolean {
    if (isLenient(source) || isLenient(target) || source.kind === 'empty') {
        return true;
    }
    if (target.kind === 'optional') {
        if (source.kind === 'none') return true;
        return isAssignable(source.kind === 'optional' ? source.inner : source, target.inner);
    }
    if (source.kind === 'none' || source.kind === 'optional') {
        return false;
    }
    switch (target.kind) {
        case 'primitive':
            if (source.kind === 'primitive') {
                if (source.name === target.name) return true;
                const s = NUMERIC_RANK[source.name], d = NUMERIC_RANK[target.name];
                if (s !== undefined && d !== undefined) return s <= d;
                // Content: anything that can be rendered
                return target.name === 'Content' && ['Text', 'Int', 'Rational'].includes(source.name);
            }
            return false;
        case 'list':
        case 'set':
            return source.kind === target.kind && isAssignable(source.element, target.element);
        case 'collection':
            return (source.kind === 'list' || source.kind === 'set' || source.kind === 'collection') && isAssignable(source.element, target.element);
        case 'interval':
            return source.kind === 'interval' && isAssignable(source.element, target.element);
        case 'enum':
            return source.kind === 'enum' && source.decl === target.decl;
        default:
            return false;
    }
}

/** Least common supertype; `any` if there is none. */
export function join(a: Type, b: Type): Type {
    if (a.kind === 'empty') return b;
    if (b.kind === 'empty') return a;
    if (a.kind === 'none') return Types.optional(b.kind === 'none' ? Types.any : b);
    if (b.kind === 'none') return Types.optional(a);
    if (a.kind === 'optional' || b.kind === 'optional') {
        const inner = join(a.kind === 'optional' ? a.inner : a, b.kind === 'optional' ? b.inner : b);
        return Types.optional(inner);
    }
    if ((a.kind === 'list' || a.kind === 'set') && a.kind === b.kind) {
        const element = join(a.element, (b as { element: Type }).element);
        return { kind: a.kind, element };
    }
    if (isAssignable(a, b)) return b;
    if (isAssignable(b, a)) return a;
    return Types.any;
}

function substitute(t: Type, s: Map<string, Type>): Type {
    switch (t.kind) {
        case 'param': return s.get(t.name) ?? Types.any;
        case 'list': case 'set': case 'collection': case 'interval': return { ...t, element: substitute(t.element, s) };
        case 'optional': return Types.optional(substitute(t.inner, s));
        default: return t;
    }
}

function unify(param: Type, arg: Type, s: Map<string, Type>, strict = true): void {
    if (param.kind === 'param') {
        if (arg.kind === 'none' || arg.kind === 'empty') return;
        const bound = s.get(param.name);
        // Conflict (e.g. Rational vs. Text): keep the type inferred first so the deviating argument
        // is reported, instead of leaving T undetermined
        const joined = bound ? join(bound, arg) : arg;
        s.set(param.name, strict && bound && joined.kind === 'any' && arg.kind !== 'any' ? bound : joined);
        return;
    }
    if (param.kind === 'optional') {
        unify(param.inner, arg.kind === 'optional' ? arg.inner : arg, s, strict);
    } else if ((param.kind === 'list' || param.kind === 'set' || param.kind === 'interval') && arg.kind === param.kind) {
        unify(param.element, arg.element, s, strict);
    } else if (param.kind === 'collection' && (arg.kind === 'list' || arg.kind === 'set')) {
        unify(param.element, arg.element, s, strict);
    }
}

// ---------------------------------------------------------------------------
// Argument matching
// ---------------------------------------------------------------------------

/** An argument paired with the parameter it fills. */
export interface ArgumentMatch {
    argument: ValueArgument;
    parameter: Parameter;
}

/** An argument that could not be matched, with a German message for the diagnostic. */
export interface ArgumentProblem {
    argument: Argument;
    message: string;
}

/** Result of matching a call's arguments against its callable's parameters. */
export interface CallInfo {
    callable: Callable;
    matches: ArgumentMatch[];
    problems: ArgumentProblem[];
    missing: Parameter[];
}

/** Parameters of a component, element or function. */
export function parametersOf(callable: Callable): Parameter[] {
    return callable.parameters;
}

/** True if a parameter has no default value, is not variadic and not optional. */
export function isRequired(p: Parameter): boolean {
    return !p.defaultValue && !p.variadic && !p.type.optional;
}

/** Matches a call's arguments to parameters: positional arguments first, then named ones. */
export function matchArguments(ref: Reference): CallInfo | undefined {
    const callable = ref.target.ref;
    if (!callable || !(isComponent(callable) || isElementDecl(callable) || isFunctionDecl(callable))) {
        return undefined;
    }
    const params = parametersOf(callable);
    const matches: ArgumentMatch[] = [];
    const problems: ArgumentProblem[] = [];
    const assigned = new Set<Parameter>();
    let position = 0;
    let seenNamed = false;
    for (const argument of ref.arguments) {
        if (isHandler(argument)) {
            continue;
        }
        if (argument.parameter) {
            seenNamed = true;
            const parameter = argument.parameter.ref;
            if (!parameter) continue;
            if (assigned.has(parameter) && !parameter.variadic) {
                problems.push({ argument, message: `Parameter '${parameter.name}' ist mehrfach angegeben.` });
            }
            assigned.add(parameter);
            matches.push({ argument, parameter });
            continue;
        }
        if (seenNamed) {
            problems.push({ argument, message: 'Positionsargumente müssen vor benannten Argumenten stehen.' });
            continue;
        }
        const parameter = params[Math.min(position, params.length - 1)];
        if (!parameter || (position >= params.length && !parameter.variadic)) {
            problems.push({ argument, message: `'${callable.name}' erwartet höchstens ${params.length} Argument(e).` });
            continue;
        }
        assigned.add(parameter);
        matches.push({ argument, parameter });
        if (!parameter.variadic) position++;
    }
    const missing = params.filter(p => isRequired(p) && !assigned.has(p));
    return { callable, matches, problems, missing };
}

// ---------------------------------------------------------------------------
// Type system service
// ---------------------------------------------------------------------------

/** Resolves declared types and infers expression types; results are cached per workspace state. */
export class TypeSystem {
    protected readonly indexManager: IndexManager;
    protected readonly documents: LangiumDocuments;
    protected readonly locator: AstNodeLocator;
    protected readonly cache: WorkspaceCache<AstNode, Type>;

    constructor(services: ItemServices) {
        this.indexManager = services.shared.workspace.IndexManager;
        this.documents = services.shared.workspace.LangiumDocuments;
        this.locator = services.workspace.AstNodeLocator;
        this.cache = new WorkspaceCache(services.shared);
    }

    /** Finds an enum in the global index. */
    findEnum(name: string): EnumDecl | undefined {
        const description = this.indexManager.allElements(EnumDecl.$type).find(d => d.name === name);
        if (!description) return undefined;
        if (description.node) return description.node as EnumDecl;
        const document = this.documents.getDocument(description.documentUri);
        return document ? this.locator.getAstNode(document.parseResult.value, description.path) as EnumDecl | undefined : undefined;
    }

    /** Resolves a type reference; undefined if the type name is unknown. */
    resolveTypeReference(ref: TypeReference): Type | undefined {
        const base = this.resolveTypeName(ref);
        if (!base) return undefined;
        return ref.optional ? Types.optional(base) : base;
    }

    protected resolveTypeName(ref: TypeReference): Type | undefined {
        const args = ref.arguments.map(a => this.resolveTypeReference(a) ?? Types.any);
        const arg = (i: number) => args[i] ?? Types.any;
        switch (ref.name) {
            case 'List': return Types.list(arg(0));
            case 'Set': return Types.set(arg(0));
            case 'Collection': return { kind: 'collection', element: arg(0) };
            case 'Interval': return Types.interval(ref.arguments.length > 0 ? arg(0) : Types.Rational);
        }
        if (PRIMITIVES.has(ref.name as PrimitiveName)) {
            return prim(ref.name as PrimitiveName);
        }
        // Only built-in elements and functions have type parameters
        const owner = AstUtils.getContainerOfType(ref, (n): n is ElementDecl | FunctionDecl => isElementDecl(n) || isFunctionDecl(n));
        if (owner?.typeParameters.some(tp => tp.name === ref.name)) {
            return { kind: 'param', name: ref.name };
        }
        const decl = this.findEnum(ref.name);
        return decl ? { kind: 'enum', decl } : undefined;
    }

    /** Expected number of type arguments per generic type name, for validating type references. */
    static readonly TYPE_ARITY: Readonly<Record<string, number>> = { List: 1, Set: 1, Collection: 1 };

    /** Resolved type of a type reference; `any` if missing or unknown. */
    declaredType(ref: TypeReference | undefined): Type {
        return ref ? this.resolveTypeReference(ref) ?? Types.any : Types.any;
    }

    /** Response type of a component; undefined if it has no response. */
    responseType(component: Component): Type | undefined {
        return component.responseType ? this.declaredType(component.responseType) : undefined;
    }

    /** Nodes whose type is being computed; a cycle (e.g. let a = a + 1) yields `any` instead of recursing forever. */
    private readonly computing = new Set<AstNode>();

    /** Inferred type of an expression. */
    typeOf(node: Expression): Type {
        return this.cache.get(node, () => this.guarded(node, () => this.computeType(node)));
    }

    /** Type of a named declaration. */
    typeOfDeclaration(node: AstNode): Type {
        return this.cache.get(node, () => this.guarded(node, () => this.computeDeclarationType(node)));
    }

    private guarded(node: AstNode, compute: () => Type): Type {
        if (this.computing.has(node)) return Types.any;
        this.computing.add(node);
        try {
            return compute();
        } finally {
            this.computing.delete(node);
        }
    }

    protected computeDeclarationType(node: AstNode): Type {
        if (isParameter(node) || isStateDecl(node)) return this.declaredType(node.type);
        if (isLetDecl(node)) return node.type ? this.declaredType(node.type) : this.typeOf(node.value);
        if (isBinding(node)) return this.typeOf(node.value);
        // Score: the type of its value; coding rule: no value in expressions (only usable as a name in sum_score)
        if (isCodingRule(node)) return isScoreRule(node) ? this.typeOf(node.value) : Types.any;
        if (isEnumMember(node)) return { kind: 'enum', decl: node.$container };
        if (isForVariable(node)) return this.forVariableType(node);
        return Types.any;
    }

    protected forVariableType(variable: ForVariable): Type {
        const loop = variable.$container as ForStatement;
        const iterable = this.typeOf(loop.iterable);
        const element = iterableElement(iterable) ?? Types.any;
        const index = loop.variables.indexOf(variable);
        if (loop.variables.length === 1) return element;
        return index === 0 ? element : Types.Int;
    }

    /** Expected type of an argument after substituting inferred type arguments. */
    expectedArgumentType(ref: Reference, parameter: Parameter): Type {
        return substitute(this.declaredType(parameter.type), this.inferTypeArguments(ref));
    }

    /** Infers type arguments of a generic element or function call from its arguments. */
    inferTypeArguments(ref: Reference): Map<string, Type> {
        const subst = new Map<string, Type>();
        const info = matchArguments(ref);
        if (!info || isComponent(info.callable) || info.callable.typeParameters.length === 0) return subst;
        for (const { argument, parameter } of info.matches) {
            // Variadic (e.g. sum_score(a, b, …)): mixed types are intended and do not fix a type parameter
            if (parameter.variadic) continue;
            unify(this.declaredType(parameter.type), this.typeOf(argument.value), subst, true);
        }
        return subst;
    }

    protected computeType(node: Expression): Type {
        if (isNumberLiteral(node)) return numberLiteralType(node);
        if (isDimensionLiteral(node)) return dimensionType(node);
        if (isStringLiteral(node)) return Types.Text;
        if (isBooleanLiteral(node)) return Types.Bool;
        if (isNoneLiteral(node)) return Types.none;
        if (isSetLiteral(node)) return Types.set(this.joinAll(node.elements));
        if (isListLiteral(node)) return Types.list(this.joinAll(node.elements));
        // (x | y): a point; missing if a coordinate may be missing, like point(x, y)
        if (isPointLiteral(node)) {
            const optional = [node.x, node.y].some(c => this.typeOf(c).kind === 'optional');
            return optional ? Types.optional(Types.Point) : Types.Point;
        }
        if (isIfExpression(node)) return join(this.typeOf(node.then), this.typeOf(node.else));
        if (isUnaryExpression(node)) return node.operator === 'not' ? Types.Bool : this.typeOf(node.operand);
        if (isRangeExpression(node)) return Types.interval(join(this.typeOf(node.from), this.typeOf(node.to)));
        if (isBinaryExpression(node)) return this.binaryType(node);
        if (isMemberAccess(node)) {
            // Point coordinates p.x, p.y (optional if the point may be missing)
            const receiver = this.typeOf(node.receiver);
            const inner = receiver.kind === 'optional' ? receiver.inner : receiver;
            if (inner.kind === 'primitive' && inner.name === 'Point' && (node.member === 'x' || node.member === 'y')) {
                return receiver.kind === 'optional' ? Types.optional(Types.Rational) : Types.Rational;
            }
            return Types.any; // other members (derived response variables) are not typed yet
        }
        if (isIndexAccess(node)) {
            // Element i (1-based); none if out of range
            const list = this.typeOf(node.receiver);
            const inner = list.kind === 'optional' ? list.inner : list;
            if (inner.kind !== 'list') return Types.any;
            // bind: list[i] or a state parameter: the element itself (the runtime checks the index)
            const arg = node.$container;
            if (isValueArgument(arg) && (arg.parameter?.$refText === 'bind' || arg.parameter?.ref?.isState)) return inner.element;
            return Types.optional(inner.element);
        }
        if (isReference(node)) return this.referenceType(node);
        return Types.any;
    }

    protected joinAll(elements: Expression[]): Type {
        return elements.reduce<Type>((acc, e) => join(acc, this.typeOf(e)), Types.empty);
    }

    protected binaryType(node: BinaryExpression): Type {
        switch (node.operator) {
            case 'and': case 'or':
            case '==': case '!=': case '<': case '<=': case '>': case '>=': case 'in':
                return Types.Bool;
        }
        const left = this.typeOf(node.left), right = this.typeOf(node.right);
        const isContent = (t: Type) => t.kind === 'primitive' && t.name === 'Content';
        if (node.operator === '+' && (isContent(left) || isContent(right))) return Types.Content;
        if (node.operator === '+' && (isText(left) || isText(right))) return Types.Text;
        if ((node.operator === '+' || node.operator === '-') && left.kind === 'set') {
            return node.operator === '+' ? join(left, right) : left;
        }
        // Arithmetic on optional numbers (e.g. number(a) + number(b)): none propagates, so the result is optional
        const l = left.kind === 'optional' ? left.inner : left, r = right.kind === 'optional' ? right.inner : right;
        if (isNumeric(l) && isNumeric(r)) {
            let widest = join(l, r);
            if (node.operator === '/' && isAssignable(widest, Types.Rational)) widest = Types.Rational;
            return left.kind === 'optional' || right.kind === 'optional' ? Types.optional(widest) : widest;
        }
        return Types.any;
    }

    protected referenceType(node: Reference): Type {
        const target = node.target.ref;
        if (!target) return Types.any;
        if (isComponent(target)) return this.responseType(target) ?? Types.Content;
        if (isElementDecl(target)) return Types.Content;
        if (isFunctionDecl(target)) {
            return substitute(this.declaredType(target.returnType), this.inferTypeArguments(node));
        }
        return this.typeOfDeclaration(target);
    }

    /** Enum expected at an expression's position (looking through if-branches), e.g. for `role: radio`. */
    expectedEnum(expr: Expression): EnumDecl | undefined {
        let node: AstNode = expr;
        while (isIfExpression(node.$container) && node.$containerProperty !== 'condition') {
            node = node.$container;
        }
        const parent = node.$container;
        let type: Type | undefined;
        if (isValueArgument(parent)) {
            const call = parent.$container;
            const parameter = parent.parameter?.ref ?? (isReference(call) ? matchArguments(call)?.matches.find(m => m.argument === parent)?.parameter : undefined);
            type = parameter ? this.declaredType(parameter.type) : undefined;
        } else if (isParameter(parent) || isStateDecl(parent)) {
            type = this.declaredType(parent.type);
        }
        if (type?.kind === 'optional') type = type.inner;
        return type?.kind === 'enum' ? type.decl : undefined;
    }
}

function isText(t: Type): boolean {
    return t.kind === 'primitive' && t.name === 'Text';
}

/** Element type of an iterable type (list, set, integer interval); undefined if not iterable. */
export function iterableElement(t: Type): Type | undefined {
    if (t.kind === 'any') return Types.any;
    if (t.kind === 'list' || t.kind === 'set') return t.element;
    if (t.kind === 'interval' && isAssignable(t.element, Types.Int)) return Types.Int;
    return undefined;
}

function numberLiteralType(node: NumberLiteral): Type {
    return node.$cstNode?.text.includes('.') ? Types.Rational : Types.Int;
}

function dimensionType(node: DimensionLiteral): Type {
    return /(ms|min|s)$/.test(node.value) ? Types.Duration : Types.Size;
}
