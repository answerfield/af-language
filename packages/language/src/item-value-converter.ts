import { DefaultValueConverter, type CstNode, type GrammarAST, type ValueType } from 'langium';

/**
 * String literals: only `\"` and `\\` are escapes; every other backslash is kept verbatim, so formulas can be
 * written as plain LaTeX: math("\frac{3}{4}") rather than "\\frac" (otherwise \f would be a form feed).
 */
export class ItemValueConverter extends DefaultValueConverter {
    protected override runConverter(rule: GrammarAST.AbstractRule, input: string, cstNode: CstNode): ValueType {
        if (rule.name.toUpperCase() === 'STRING') return input.slice(1, -1).replace(/\\(["\\])/g, '$1');
        return super.runConverter(rule, input, cstNode);
    }
}
