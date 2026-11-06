import { AstUtils, CstUtils, GrammarUtils, type LangiumDocument, type MaybePromise } from 'langium';
import type { CodeActionProvider } from 'langium/lsp';
import { CodeActionKind, type CodeAction, type CodeActionParams, type Command, type Diagnostic } from 'vscode-languageserver';
import { isBinaryExpression, isContentStatement, isReference, isValueArgument, type Document } from '../generated/ast.js';
import { numberedOptions } from '../options.js';
import { IssueCodes } from '../item-validator.js';

/** Quick fixes for diagnostics that carry a code (see {@link IssueCodes}). */
export class ItemCodeActionProvider implements CodeActionProvider {

    getCodeActions(document: LangiumDocument, params: CodeActionParams): MaybePromise<Array<Command | CodeAction>> {
        return params.context.diagnostics.flatMap(d => {
            const action = this.createAction(document as LangiumDocument<Document>, d);
            return action ? [action] : [];
        });
    }

    protected createAction(document: LangiumDocument<Document>, diagnostic: Diagnostic): CodeAction | undefined {
        const code = (diagnostic.data as { code?: string } | undefined)?.code;
        const root = document.parseResult.value.$cstNode;
        if (!code || !root) return undefined;
        const offset = document.textDocument.offsetAt(diagnostic.range.start);
        const leaf = CstUtils.findLeafNodeAtOffset(root, offset);
        if (!leaf) return undefined;
        const uri = document.textDocument.uri;
        const edit = (range: { start: number; end: number }, newText: string, title: string): CodeAction => ({
            title, kind: CodeActionKind.QuickFix, diagnostics: [diagnostic], isPreferred: true,
            edit: { changes: { [uri]: [{ range: { start: document.textDocument.positionAt(range.start), end: document.textDocument.positionAt(range.end) }, newText }] } }
        });

        switch (code) {
            case IssueCodes.UnboundResponse: {
                const statement = AstUtils.getContainerOfType(leaf.astNode, isContentStatement);
                const call = statement && isReference(statement.expression) ? statement.expression : undefined;
                if (!statement?.$cstNode || !call) return undefined;
                const name = lowerFirst(call.target.$refText);
                return edit({ start: statement.$cstNode.offset, end: statement.$cstNode.offset }, `${name} = `, `Antwort als '${name}' binden`);
            }
            case IssueCodes.MissingLabel: {
                const call = AstUtils.getContainerOfType(leaf.astNode, isReference);
                const open = call?.$cstNode ? GrammarUtils.findNodeForKeyword(call.$cstNode, '(') : undefined;
                if (!call || !open) return undefined;
                const separator = call.arguments.length > 0 ? ', ' : '';
                return edit({ start: open.end, end: open.end }, `label: ""${separator}`, "'label' ergänzen");
            }
            case IssueCodes.OptionNumbers: {
                const comparison = AstUtils.getContainerOfType(leaf.astNode, isBinaryExpression);
                const numbered = comparison && numberedOptions(comparison);
                if (!numbered?.target.$cstNode) return undefined;
                return edit({ start: numbered.target.$cstNode.offset, end: numbered.target.$cstNode.end }, numbered.text, `Als ${numbered.text} schreiben`);
            }
            case IssueCodes.PointNotation: {
                const call = AstUtils.getContainerOfType(leaf.astNode, isReference);
                const [x, y] = (call?.arguments ?? []).map(a => isValueArgument(a) ? a.value.$cstNode?.text : undefined);
                if (!call?.$cstNode || !x || !y) return undefined;
                return edit({ start: call.$cstNode.offset, end: call.$cstNode.end }, `(${x} | ${y})`, `Als (${x} | ${y}) schreiben`);
            }
        }
        return undefined;
    }
}

function lowerFirst(s: string): string {
    return s.charAt(0).toLowerCase() + s.slice(1);
}
