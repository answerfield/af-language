import { type AstNode, type CstNode } from 'langium';
import { AbstractFormatter, Formatting, type FormattingAction, type FormattingContext } from 'langium/lsp';
import type { TextEdit } from 'vscode-languageserver-types';
import {
    isCoding, isComponent, isContentStatement, isElementDecl, isEnumDecl,
    isForStatement, isItem, isBooklet, isReference, type Component
} from '../generated/ast.js';

/**
 * Formats indentation and line breaks of blocks. Spacing within a line
 * (e.g. aligned coding cases) is left untouched.
 */
export class ItemFormatter extends AbstractFormatter {

    protected format(node: AstNode): void {
        const children = blockChildren(node);
        if (!children) return;
        const formatter = this.getNodeFormatter(node);
        const open = formatter.keyword('{');
        const close = formatter.keyword('}');
        if (open.nodes.length === 0 || close.nodes.length === 0) return;

        // Multi-line component signature: put `{` on its own line
        open.prepend(isComponent(node) && signatureLines(node) > 1 ? Formatting.newLine() : Formatting.oneSpace());
        const singleLine = open.nodes[0].range.start.line === close.nodes[close.nodes.length - 1].range.end.line;
        if (isInline(node, children, singleLine)) {
            open.append(Formatting.oneSpace());
            close.prepend(Formatting.oneSpace());
            return;
        }
        close.prepend(Formatting.newLine());
        // allowMore keeps blank lines between statements
        formatter.interior(open, close).prepend(Formatting.indent({ allowMore: true }));
        if (!isFlow(node)) return;
        // Running text (p): pieces on the same line stay together ("Kom" g1 = Gap(…) "scherweise")
        let line = open.nodes[0].range.end.line;
        for (const child of children) {
            const range = child.$cstNode?.range;
            if (!range) continue;
            if (range.start.line === line) formatter.node(child).prepend(Formatting.oneSpace({ priority: 1 }));
            line = range.end.line;
        }
    }

    /**
     * Comments between statements follow the block indentation; comments inside argument lists
     * and expressions keep their (possibly aligned) position.
     */
    protected override createHiddenTextEdits(previous: CstNode | undefined, hidden: CstNode, formatting: FormattingAction | undefined, context: FormattingContext): TextEdit[] {
        const owner = hidden.container?.astNode;
        if (owner && !isBlockOwner(owner)) return [];
        return super.createHiddenTextEdits(previous, hidden, formatting, context);
    }
}

/** Paragraph with running text: children flow inline like words in a sentence. */
function isFlow(node: AstNode): boolean {
    return isContentStatement(node) && isReference(node.expression) && node.expression.target.$refText === 'p';
}

function isBlockOwner(node: AstNode): boolean {
    return node.$type === 'Document' || blockChildren(node) !== undefined;
}

function signatureLines(component: Component): number {
    const start = component.$cstNode?.range.start.line ?? 0;
    const end = [component.responseType, ...component.parameters]
        .map(n => n?.$cstNode?.range.end.line ?? start)
        .reduce((a, b) => Math.max(a, b), start);
    return end - start + 1;
}

function blockChildren(node: AstNode): AstNode[] | undefined {
    if (isComponent(node) || isItem(node) || isBooklet(node) || isForStatement(node)) return node.body;
    if (isContentStatement(node)) return node.hasBody ? node.body : undefined;
    if (isCoding(node)) return node.rules;
    if (isEnumDecl(node) || isElementDecl(node)) return undefined;
    return undefined;
}

/**
 * A block stays on one line if it is already written on one line and has no nested blocks,
 * e.g. `toggle(…) { option }` or `p { "Kürze 6/8: " reduce = Gap(…) }`.
 */
function isInline(node: AstNode, children: AstNode[], singleLine: boolean): boolean {
    if (children.length === 0) return true;
    if (isComponent(node) || isItem(node) || isCoding(node) || isBooklet(node)) return false;
    return singleLine && children.every(c => !blockChildren(c)?.length);
}
