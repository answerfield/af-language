// Choice responses compared by option text: greater == {"3/5"} instead of greater == {2}. The compiler replaces the
// texts by the option numbers, so bundle and coding are unchanged.
import { AstUtils, type AstNode } from 'langium';
import {
    isBinaryExpression, isBinding, isListLiteral, isNumberLiteral, isReference, isSetLiteral, isStringLiteral,
    type BinaryExpression, type Expression, type StringLiteral
} from './generated/ast.js';
import { matchArguments } from './type-system.js';

/** Plain option texts of a response bound to a call with a literal `options` list (Choice, Select, Tabs …). */
export function optionTexts(expr: Expression): string[] | undefined {
    if (!isReference(expr) || expr.isCall) return undefined;
    const binding = expr.target.ref;
    if (!isBinding(binding) || !isReference(binding.value)) return undefined;
    const options = matchArguments(binding.value)?.matches.find(m => m.parameter.name === 'options')?.argument.value;
    return isListLiteral(options) && options.elements.length > 0 && options.elements.every(isStringLiteral)
        ? options.elements.map(e => e.value) : undefined;
}

/** A comparison (==, !=, in) of such a response with option texts: the texts' side, the texts and the options. */
export interface OptionComparison {
    side: 'left' | 'right';
    texts: StringLiteral[];
    options: string[];
}

export function optionComparison(node: BinaryExpression): OptionComparison | undefined {
    if (node.operator !== '==' && node.operator !== '!=' && node.operator !== 'in') return undefined;
    const textsOf = (e: Expression): StringLiteral[] | undefined =>
        isStringLiteral(e) ? [e] : isSetLiteral(e) && e.elements.length > 0 && e.elements.every(isStringLiteral) ? e.elements : undefined;
    const left = optionTexts(node.left), right = optionTexts(node.right);
    const leftTexts = textsOf(node.left), rightTexts = textsOf(node.right);
    if (left && rightTexts) return { side: 'right', texts: rightTexts, options: left };
    if (right && leftTexts) return { side: 'left', texts: leftTexts, options: right };
    return undefined;
}

/** Option number (from 1) of a text; undefined if no option has it. */
export function optionNumber(options: readonly string[], text: string): number | undefined {
    const index = options.indexOf(text);
    return index < 0 ? undefined : index + 1;
}

/** Option texts short and plain enough to stand in a coding instead of their numbers. */
function readable(text: string): boolean {
    return text.length > 0 && text.length <= 40 && !/["\\{}\n]/.test(text);
}

/**
 * The reverse: a choice response compared with option numbers ({2}, 2) whose options read well as text. Returns the
 * number side with its replacement, e.g. {"3/5"}.
 */
export function numberedOptions(node: BinaryExpression): { target: Expression; text: string } | undefined {
    if (node.operator !== '==' && node.operator !== '!=' && node.operator !== 'in') return undefined;
    const numbersOf = (e: Expression): number[] | undefined =>
        isNumberLiteral(e) ? [e.value] : isSetLiteral(e) && e.elements.length > 0 && e.elements.every(isNumberLiteral) ? e.elements.map(n => n.value) : undefined;
    for (const [response, other] of [[node.left, node.right], [node.right, node.left]] as const) {
        const options = optionTexts(response);
        const numbers = options && numbersOf(other);
        if (!options || !numbers) continue;
        const texts = numbers.map(n => Number.isInteger(n) && n >= 1 ? options[n - 1] : undefined);
        // Only texts that name exactly one option
        if (!texts.every((t): t is string => t !== undefined && readable(t) && options.indexOf(t) === options.lastIndexOf(t))) return undefined;
        const quoted = texts.map(t => `"${t}"`);
        return { target: other, text: isSetLiteral(other) ? `{${quoted.join(', ')}}` : quoted[0] };
    }
    return undefined;
}

/** Edits that turn every readable numbered option comparison in a document into option texts (import, migration). */
export function optionTextEdits(root: AstNode): Array<{ start: number; end: number; text: string }> {
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const node of AstUtils.streamAst(root)) {
        if (!isBinaryExpression(node)) continue;
        const numbered = numberedOptions(node);
        const cst = numbered?.target.$cstNode;
        if (numbered && cst) edits.push({ start: cst.offset, end: cst.end, text: numbered.text });
    }
    return edits;
}
