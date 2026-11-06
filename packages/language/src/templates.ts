// Placeholders in texts: "Reihe {r}, Platz {c}" instead of "Reihe " + r + ", Platz " + c. A placeholder is a name, optionally
// with members ({p.x}); {{ and }} are literal braces, and braces around anything else stay text ("Punkte {3, 9}").
// LaTeX, answer patterns and coding criteria (often quoted from guides with LaTeX) keep their braces: the text arguments
// of math, accept, accepted and manual have no placeholders.
import type { AstNode, Reference as LangiumReference, ReferenceInfo, ScopeProvider } from 'langium';
import { isReference, isValueArgument, type Reference } from './generated/ast.js';

export interface Placeholder {
    /** Name and members, e.g. ['p', 'x']. */
    path: string[];
    /** Offsets within the text (without quotes), including the braces. */
    start: number;
    end: number;
}

export type TemplatePart = string | Placeholder;

/** Text and placeholders; undefined if the text has none (and no {{ or }}). */
export function templateParts(text: string): TemplatePart[] | undefined {
    if (!text.includes('{') && !text.includes('}')) return undefined;
    const parts: TemplatePart[] = [];
    let literal = '', found = false;
    for (let i = 0; i < text.length;) {
        if (text.startsWith('{{', i) || text.startsWith('}}', i)) {
            literal += text[i];
            i += 2;
            found = true;
            continue;
        }
        const m = text[i] === '{' ? /^\{\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\}/.exec(text.slice(i)) : null;
        if (m) {
            if (literal) parts.push(literal);
            literal = '';
            parts.push({ path: m[1].split('.'), start: i, end: i + m[0].length });
            i += m[0].length;
            found = true;
            continue;
        }
        literal += text[i++];
    }
    if (literal) parts.push(literal);
    return found ? parts : undefined;
}

/** Built-in functions whose text arguments keep their braces (LaTeX, answer patterns, criteria). */
const VERBATIM = new Set(['math', 'accept', 'accepted', 'manual']);

/** Whether a string node is an argument of math, accept, accepted or manual (its braces are not placeholders). */
export function isVerbatimText(node: AstNode): boolean {
    const argument = isValueArgument(node.$container) ? node.$container : undefined;
    const call = argument?.$container ?? node.$container;
    return isReference(call) && call.isCall && VERBATIM.has(call.target.$refText);
}

/** Text of a string or a content statement's short text (p "…"), if it may hold placeholders. */
export function templateOf(node: AstNode, text: string | undefined): TemplatePart[] | undefined {
    return text === undefined || isVerbatimText(node) ? undefined : templateParts(text);
}

/**
 * The declaration a placeholder's name refers to, resolved as if the name stood at `node` (a parameter, state, let,
 * loop variable, response or function); undefined if unknown there.
 */
export function resolvePlaceholder(scopes: ScopeProvider, node: AstNode, name: string): AstNode | undefined {
    // A reference as Langium sees one, placed at the text: the scope is the text's surroundings
    const probe = { $type: 'Reference', $container: node, $containerProperty: 'expression', isCall: false, arguments: [] } as unknown as Reference;
    const target = { $refText: name } as LangiumReference;
    (probe as { target: LangiumReference }).target = target;
    const context: ReferenceInfo = { reference: target, container: probe, property: 'target' };
    try {
        return scopes.getScope(context).getElement(name)?.node;
    } catch {
        return undefined;
    }
}
