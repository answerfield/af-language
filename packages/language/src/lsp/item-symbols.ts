import { GrammarUtils, type AstNode, type LangiumDocument, type MaybePromise } from 'langium';
import type { DocumentSymbolProvider } from 'langium/lsp';
import { SymbolKind, type DocumentSymbol, type DocumentSymbolParams } from 'vscode-languageserver';
import { isScoreRule, itemRefOf } from '../item-scope.js';
import {
    isBinding, isBooklet, isCoding, isCodingRule, isComponent, isContentStatement,
    isElementDecl, isEnumDecl, isForStatement, isFunctionDecl, isHandler, isItem,
    isLetDecl, isReference, isResponseStatement, isStateDecl, isStringLiteral,
    type Document
} from '../generated/ast.js';

const MAX_DETAIL = 40;

/**
 * Document structure for the outline, breadcrumbs and the "AF-Struktur" view: items with pages, sections,
 * paragraphs, conditions, loops and responses; codings; booklets.
 */
export class ItemDocumentSymbolProvider implements DocumentSymbolProvider {

    getSymbols(document: LangiumDocument, _params: DocumentSymbolParams): MaybePromise<DocumentSymbol[]> {
        const root = document.parseResult.value as Document;
        return root.elements.flatMap(e => this.symbol(document, e));
    }

    protected symbol(document: LangiumDocument, node: AstNode): DocumentSymbol[] {
        const entry = this.describe(node);
        if (!entry || !node.$cstNode) return [];
        const range = node.$cstNode.range;
        const nameNode = entry.nameProperty ? GrammarUtils.findNodeForProperty(node.$cstNode, entry.nameProperty) : undefined;
        const children = entry.children.flatMap(c => this.symbol(document, c));
        return [{
            name: entry.name,
            ...(entry.detail ? { detail: shorten(entry.detail) } : {}),
            kind: entry.kind,
            range,
            selectionRange: nameNode?.range ?? { start: range.start, end: range.start },
            ...(children.length > 0 ? { children } : {})
        }];
    }

    protected describe(node: AstNode): { name: string; detail?: string; kind: SymbolKind; nameProperty?: string; children: AstNode[] } | undefined {
        if (isItem(node)) return { name: `item ${node.name}`, detail: node.title, kind: SymbolKind.Class, nameProperty: 'name', children: node.body };
        if (isComponent(node)) return { name: `component ${node.name}`, detail: node.responseType?.$cstNode?.text, kind: SymbolKind.Interface, nameProperty: 'name', children: node.body };
        if (isCoding(node)) return { name: `coding ${node.item.$refText}`, kind: SymbolKind.Function, nameProperty: 'item', children: node.rules };
        if (isBooklet(node)) return { name: `booklet ${node.name}`, detail: node.title, kind: SymbolKind.Package, nameProperty: 'name', children: node.body };
        const item = itemRefOf(node);
        if (item) return { name: item.name, detail: item.title, kind: SymbolKind.Class, children: [] };

        if (isBinding(node)) {
            const call = isReference(node.value) ? node.value.target.$refText : undefined;
            return { name: node.name, detail: call, kind: SymbolKind.Field, nameProperty: 'name', children: [] };
        }
        if (isStateDecl(node)) return { name: `state ${node.name}`, detail: node.type.$cstNode?.text, kind: SymbolKind.Variable, nameProperty: 'name', children: [] };
        if (isLetDecl(node)) return { name: `let ${node.name}`, kind: SymbolKind.Constant, nameProperty: 'name', children: [] };
        if (isForStatement(node)) {
            return { name: `for ${node.variables.map(v => v.name).join(', ')}`, detail: `in ${node.iterable.$cstNode?.text ?? ''}`, kind: SymbolKind.Array, children: node.body };
        }
        if (isResponseStatement(node)) return { name: 'response', detail: node.value.$cstNode?.text, kind: SymbolKind.Event, children: [] };
        if (isContentStatement(node)) {
            const expr = node.expression;
            if (isStringLiteral(expr)) return { name: `"${shorten(expr.value)}"`, kind: SymbolKind.String, children: [] };
            const target = isReference(expr) ? expr.target.ref : undefined;
            if (isReference(expr) && (isElementDecl(target) || isComponent(target))) {
                // Detail: short text, heading, or first argument (e.g. show(when: …), part("Teil 1"), variant(simple_language))
                const heading = expr.arguments.find(a => a.$type === 'ValueArgument' && (a as { parameter?: { $refText: string } }).parameter?.$refText === 'heading');
                const detail = node.text ?? (heading ?? expr.arguments[0])?.$cstNode?.text.replace(/^\w+:\s*/, '');
                return { name: expr.target.$refText, ...(detail ? { detail } : {}), kind: isComponent(target) ? SymbolKind.Object : SymbolKind.Struct, children: node.body };
            }
            return { name: expr.$cstNode?.text ?? 'Inhalt', kind: SymbolKind.String, children: [] };
        }

        if (isCodingRule(node)) {
            // Coding rule: correct(…) shows its condition, codes(…) its code count; a score shows its expression
            const call = isReference(node.value) ? node.value : undefined;
            // count only the codes, not the feedback arguments (otherwise, hints, solution)
            const codes = call && call.target.$refText === 'codes' ? call.arguments.filter(a => !isHandler(a) && !a.parameter) : [];
            const detail = call?.target.$refText === 'correct' ? shorten(call.arguments[0]?.$cstNode?.text ?? '')
                : codes.length > 0 ? `${codes.length} Codes` : shorten(node.value.$cstNode?.text ?? '');
            return { name: node.name, detail, kind: isScoreRule(node) ? SymbolKind.Number : SymbolKind.Field, nameProperty: 'name', children: [] };
        }

        if (isElementDecl(node) || isFunctionDecl(node)) return { name: node.name, kind: SymbolKind.Function, nameProperty: 'name', children: [] };
        if (isEnumDecl(node)) return { name: `enum ${node.name}`, kind: SymbolKind.Enum, nameProperty: 'name', children: [] };
        return undefined;
    }
}

function shorten(text: string): string {
    const single = text.replace(/\s+/g, ' ').trim();
    return single.length > MAX_DETAIL ? single.slice(0, MAX_DETAIL - 1) + '…' : single;
}
