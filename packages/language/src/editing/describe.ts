import type { NodeDescription, ParamDescription, PointHandle, ValueDescription } from '@answerfield/editing';
import type { LangiumDocument } from 'langium';
import {
    isBinding, isBooleanLiteral, isComponent, isContentStatement, isDimensionLiteral, isElementDecl, isEnumMember,
    isForStatement, isItem, isListLiteral, isNumberLiteral, isRangeExpression, isReference, isStringLiteral,
    isBinaryExpression, isUnaryExpression, isFunctionDecl, isPointLiteral, isStatement, type Expression
} from '../generated/ast.js';
import { builtinElementOf } from '../item-scope.js';
import { matchArguments, isRequired, printType } from '../type-system.js';
import type { ItemServices } from '../item-module.js';
import { bodyOf, callOf, nodeById, PSEUDO } from './edits.js';
import { codingSuggestions, ruleOf } from './coding.js';
import { itemOf } from './palette.js';

export type { NodeDescription, ParamDescription, ValueDescription } from '@answerfield/editing';

/** Describes a node for the visual editor's property panel: label, kind, parameters with current values, drag handles and actions. */
export function describeNode(services: ItemServices, document: LangiumDocument, id: string): NodeDescription | undefined {
    const node = nodeById(services, document, id);
    if (!node) return undefined;
    const docs = services.documentation.DocumentationProvider;
    const types = services.types.TypeSystem;
    const base = { id, container: bodyOf(node) !== undefined, removable: !isItem(node) };

    if (isItem(node)) {
        return {
            ...base, label: `item ${node.name}`, kind: 'item',
            params: [{ name: PSEUDO.title, label: 'Titel', type: 'Text', required: false, ...(node.title !== undefined ? { value: { kind: 'text', value: node.title } } : {}) }]
        };
    }
    if (isComponent(node)) {
        // Declaration: documentation and signature; its body is edited in the preview (see compileForEditor)
        const doc = docs.getDocumentation(node);
        return {
            ...base, removable: false, label: `component ${node.name}`, kind: 'component', params: [
                { name: PSEUDO.doc, label: 'Beschreibung', type: 'Text', required: false, doc: 'Erscheint in der Palette und beim Überfahren.', ...(doc ? { value: { kind: 'text', value: doc } } : {}) },
                {
                    name: PSEUDO.params, label: 'Parameter', type: 'List<Parameter>', required: false, newItem: 'name: Text',
                    doc: 'Je Eintrag name: Typ, optional = Standardwert; state name: Typ = Anfangswert bindet einen Zustand des Aufrufers.',
                    value: { kind: 'list', items: node.parameters.map(p => ({ kind: 'expression' as const, value: p.$cstNode?.text ?? p.name })) }
                },
                {
                    name: PSEUDO.response, label: 'Antworttyp', type: 'Typ', required: false, doc: 'Leer: reine Darstellung ohne Antwort.',
                    suggestions: ['Text?', 'Int?', 'Rational?', 'Bool', 'Set<Int>', 'Point?', 'List<Point?>'].map(value => ({ value })),
                    ...(node.responseType?.$cstNode ? { value: { kind: 'expression', text: node.responseType.$cstNode.text } } : {})
                },
                { name: PSEUDO.children, label: 'Nimmt Inhalt (children)', type: 'Bool', required: false, value: { kind: 'bool', value: node.acceptsChildren === true } }
            ]
        };
    }
    if (isForStatement(node)) {
        return {
            ...base, label: `for ${node.variables.map(v => v.name).join(', ')}`, kind: 'for',
            params: [{ name: PSEUDO.iterable, label: 'in', type: 'List', required: true, value: describeValue(node.iterable) }]
        };
    }
    if (isContentStatement(node) && isStringLiteral(node.expression)) {
        return { ...base, label: 'Text', kind: 'content', params: [{ name: PSEUDO.text, label: 'Text', type: 'Text', required: true, value: { kind: 'text', value: node.expression.value } }] };
    }

    const call = callOf(node);
    const callable = call?.target.ref;
    if (!call || !callable || !('parameters' in callable)) {
        return { ...base, label: node.$cstNode?.text.split('\n')[0].slice(0, 40) ?? node.$type, kind: 'other', params: [] };
    }
    const info = matchArguments(call);
    const params: ParamDescription[] = callable.parameters
        // Bindings (bind, state parameters) are not settings
        .filter(p => p.name !== 'bind' && !p.isState && !p.variadic)
        .map(p => {
            const match = info?.matches.find(m => m.parameter === p);
            const type = types.declaredType(p.type);
            const enumDecl = type.kind === 'enum' ? type.decl : type.kind === 'optional' && type.inner.kind === 'enum' ? type.inner.decl : undefined;
            const doc = docs.getDocumentation(p);
            return {
                name: p.name, label: p.name, type: printType(type), required: isRequired(p),
                ...(p.defaultValue?.$cstNode ? { default: p.defaultValue.$cstNode.text } : {}),
                ...(enumDecl ? { enumValues: enumDecl.members.map(m => m.name) } : {}),
                ...(doc ? { doc } : {}),
                ...(match ? { value: describeValue(match.argument.value), ...(match.argument.parameter ? {} : { positional: true }) } : {})
            } satisfies ParamDescription;
        });
    if (isContentStatement(node) && node.text !== undefined) {
        params.unshift({ name: PSEUDO.text, label: 'Text', type: 'Text', required: true, value: { kind: 'text', value: node.text } });
    }
    const kind = isComponent(callable) ? 'component' : isElementDecl(callable) ? (callable.events.length > 0 ? 'atom' : 'element') : 'function';
    const doc = docs.getDocumentation(callable);
    // Draggable handles: (x | y) with literal numbers, also inside lists
    const points: PointHandle[] = [];
    for (const m of info?.matches ?? []) {
        const value = m.argument.value;
        const label = m.parameter.name === 'at' ? textOf(info?.matches.find(x => x.parameter.name === 'label')?.argument.value) : undefined;
        const one = pointOf(value);
        if (one) points.push({ param: m.parameter.name, ...one, ...(label ? { label } : {}) });
        else if (isListLiteral(value)) value.elements.forEach((e, index) => {
            const p = pointOf(e);
            if (p) points.push({ param: m.parameter.name, index, ...p });
        });
    }
    // A response of an item: its coding rule, with typical rules to pick from
    const item = isBinding(node) ? itemOf(node) : undefined;
    if (isBinding(node) && item) {
        const rule = ruleOf(services, item, node.name);
        params.push({
            name: PSEUDO.coding, label: 'Kodierung', type: 'Kodierung', required: false,
            doc: 'Regel im coding-Block; leer entfernt sie.', suggestions: codingSuggestions(services, node),
            ...(rule?.value.$cstNode ? { value: { kind: 'expression', text: rule.value.$cstNode.text } } : {})
        });
    }
    const actions: NonNullable<NodeDescription['actions']> = [];
    if (isStatement(node) && base.removable) actions.push('duplicate');
    if (isStatement(node) && base.removable && item === undefined && itemOf(node)) actions.push('extract');
    if (builtinElementOf(node) === 'table') actions.push('addColumn');
    return {
        ...base,
        container: base.container || (isElementDecl(callable) && callable.acceptsChildren && isContentStatement(node) && node.text === undefined),
        label: callable.name, kind,
        ...(isBinding(node) ? { binding: node.name } : {}),
        ...(doc ? { doc } : {}),
        params,
        ...(points.length > 0 ? { points } : {}),
        ...(actions.length > 0 ? { actions } : {})
    };
}

/** Coordinates of `(x | y)` or `point(x, y)` with literal numbers; undefined otherwise. */
function pointOf(expr: Expression): { x: number; y: number } | undefined {
    if (isPointLiteral(expr)) {
        const x = numberOf(expr.x), y = numberOf(expr.y);
        return x !== undefined && y !== undefined ? { x, y } : undefined;
    }
    if (!isReference(expr) || !expr.isCall || !isFunctionDecl(expr.target.ref) || expr.target.ref.name !== 'point' || expr.arguments.length !== 2) return undefined;
    const [x, y] = expr.arguments.map(a => 'value' in a ? numberOf(a.value) : undefined);
    return x !== undefined && y !== undefined ? { x, y } : undefined;
}

function numberOf(expr: Expression): number | undefined {
    if (isNumberLiteral(expr)) return expr.value;
    if (isUnaryExpression(expr) && expr.operator === '-') { const v = numberOf(expr.operand); return v === undefined ? undefined : -v; }
    if (isBinaryExpression(expr) && expr.operator === '/') {
        const a = numberOf(expr.left), b = numberOf(expr.right);
        return a !== undefined && b ? a / b : undefined;
    }
    return undefined;
}

function textOf(expr: Expression | undefined): string | undefined {
    return expr && isStringLiteral(expr) ? expr.value : undefined;
}

function describeValue(expr: Expression): ValueDescription {
    const text = expr.$cstNode?.text ?? '';
    if (isStringLiteral(expr)) return { kind: 'text', value: expr.value };
    if (isNumeric(expr)) return { kind: 'number', text: text.replace(/\s+/g, '') };
    if (isBooleanLiteral(expr)) return { kind: 'bool', value: expr.value };
    if (isDimensionLiteral(expr)) return { kind: 'size', text: expr.value };
    if (isReference(expr) && !expr.isCall && isEnumMember(expr.target.ref)) return { kind: 'enum', value: expr.target.ref.name };
    if (isRangeExpression(expr) && isNumeric(expr.from) && isNumeric(expr.to)) {
        return { kind: 'interval', from: expr.from.$cstNode!.text, to: expr.to.$cstNode!.text };
    }
    if (isListLiteral(expr)) {
        // Texts and numbers become fields; anything else (image(…), wording(…), (x | y)) stays a per-entry expression
        return {
            kind: 'list',
            items: expr.elements.map(e => isStringLiteral(e) ? { kind: 'text' as const, value: e.value }
                : isNumeric(e) ? { kind: 'number' as const, value: e.$cstNode!.text.replace(/\s+/g, '') }
                : { kind: 'expression' as const, value: e.$cstNode?.text ?? '' })
        };
    }
    return { kind: 'expression', text };
}

/** A number or a fraction of number literals, e.g. `3`, `1/20`, `-0.5`. */
function isNumeric(expr: Expression): boolean {
    if (isNumberLiteral(expr)) return true;
    if (isUnaryExpression(expr) && expr.operator === '-') return isNumeric(expr.operand);
    return isBinaryExpression(expr) && expr.operator === '/' && isNumberLiteral(expr.left) && isNumberLiteral(expr.right);
}

