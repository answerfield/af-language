import { type AstNode } from 'langium';
import { AbstractSemanticTokenProvider, type SemanticTokenAcceptor } from 'langium/lsp';
import { SemanticTokenModifiers, SemanticTokenTypes } from 'vscode-languageserver';
import {
    isBinding, isCodingRule, isComponent, isDimensionLiteral, isElementDecl, isEnumMember,
    isForVariable, isFunctionDecl, isHandler, isItem, isLetDecl, isNumberLiteral, isParameter,
    isReference, isStateDecl, isTypeReference, isValueArgument, isCoding,
    isAssignment, isBooklet
} from '../generated/ast.js';

/** Highlights references by what they denote: atoms, components, roles, state, responses, … */
export class ItemSemanticTokenProvider extends AbstractSemanticTokenProvider {

    protected highlightElement(node: AstNode, acceptor: SemanticTokenAcceptor): void {
        if (isReference(node)) {
            const type = tokenTypeOf(node.target.ref);
            if (type) acceptor({ node, property: 'target', type, modifier: modifiersOf(node.target.ref) });
        } else if (isComponent(node) || isElementDecl(node) || isFunctionDecl(node)) {
            acceptor({ node, property: 'name', type: tokenTypeOf(node)!, modifier: SemanticTokenModifiers.declaration });
        } else if (isBooklet(node)) {
            acceptor({ node, property: 'name', type: SemanticTokenTypes.namespace, modifier: SemanticTokenModifiers.declaration });
        } else if (isItem(node)) {
            acceptor({ node, property: 'name', type: SemanticTokenTypes.namespace, modifier: SemanticTokenModifiers.declaration });
        } else if (isParameter(node) || isStateDecl(node) || isLetDecl(node) || isForVariable(node) || isBinding(node)) {
            acceptor({ node, property: 'name', type: tokenTypeOf(node)!, modifier: SemanticTokenModifiers.declaration });
        } else if (isTypeReference(node)) {
            acceptor({ node, property: 'name', type: SemanticTokenTypes.type });
        } else if (isValueArgument(node) && node.parameter) {
            acceptor({ node, property: 'parameter', type: SemanticTokenTypes.parameter });
        } else if (isHandler(node)) {
            acceptor({ node, property: 'event', type: SemanticTokenTypes.event });
        } else if (isAssignment(node)) {
            acceptor({ node, property: 'target', type: SemanticTokenTypes.variable, modifier: SemanticTokenModifiers.modification });
        } else if (isNumberLiteral(node) || isDimensionLiteral(node)) {
            acceptor({ node, property: 'value', type: SemanticTokenTypes.number });
        } else if (isCoding(node)) {
            acceptor({ node, property: 'item', type: SemanticTokenTypes.namespace });
        } else if (isCodingRule(node)) {
            acceptor({ node, property: 'name', type: SemanticTokenTypes.property });
        }
    }
}

function tokenTypeOf(target: AstNode | undefined): string | undefined {
    if (isComponent(target)) return SemanticTokenTypes.class;
    // Atoms (elements with events) are highlighted differently from layout elements
    if (isElementDecl(target)) return target.events.length > 0 ? SemanticTokenTypes.function : SemanticTokenTypes.macro;
    if (isFunctionDecl(target)) return SemanticTokenTypes.function;
    if (isEnumMember(target)) return SemanticTokenTypes.enumMember;
    if (isParameter(target)) return SemanticTokenTypes.parameter;
    if (isStateDecl(target) || isLetDecl(target) || isForVariable(target)) return SemanticTokenTypes.variable;
    if (isBinding(target) || isCodingRule(target)) return SemanticTokenTypes.property;
    return undefined;
}

function modifiersOf(target: AstNode | undefined): string[] {
    if (isLetDecl(target) || isForVariable(target)) return [SemanticTokenModifiers.readonly];
    if (isElementDecl(target) || isFunctionDecl(target) || isEnumMember(target)) return [SemanticTokenModifiers.defaultLibrary];
    return [];
}
