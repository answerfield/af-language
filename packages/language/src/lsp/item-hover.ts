import { AstUtils, isJSDoc, parseJSDoc, type AstNode, type CommentProvider, type JSDocComment, type JSDocTag, type MaybePromise } from 'langium';
import { MultilineCommentHoverProvider, type LangiumServices } from 'langium/lsp';
import {
    isBinding, isCodingRule, isComponent, isElementDecl, isEnumMember, isForVariable, isFunctionDecl, isItem,
    isLetDecl, isParameter, isStateDecl, isBooklet, isEnumDecl, type EnumDecl, type Parameter, type TypeParameter
} from '../generated/ast.js';
import { printType, type TypeSystem } from '../type-system.js';
import type { ItemAddedServices } from '../item-module.js';
import { builtinElementOf, isScoreRule, itemRefOf } from '../item-scope.js';

/** Hover showing a declaration's signature (with inferred types) followed by its doc comment. */
export class ItemHoverProvider extends MultilineCommentHoverProvider {
    protected readonly types: TypeSystem;
    protected readonly comments: CommentProvider;

    constructor(services: LangiumServices & ItemAddedServices) {
        super(services);
        this.types = services.types.TypeSystem;
        this.comments = services.documentation.CommentProvider;
    }

    protected override getAstNodeHoverContent(node: AstNode): MaybePromise<string | undefined> {
        const signature = this.signature(node);
        const comment = isParameter(node) ? this.parameterDoc(node) : this.describe(node);
        const parts = [signature ? '```af\n' + signature + '\n```' : undefined, comment].filter(Boolean);
        return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
    }

    /** Doc comment as JSDoc, if the node has one. */
    protected jsdoc(node: AstNode): JSDocComment | undefined {
        const comment = this.comments.getComment(node);
        return comment && isJSDoc(comment) ? parseJSDoc(comment) : undefined;
    }

    /** Description without tags, then the parameters (`@param name text`) as a list. */
    protected describe(node: AstNode): string | undefined {
        const doc = this.jsdoc(node);
        if (!doc) return this.documentationProvider.getDocumentation(node);
        const text = doc.elements.filter(e => !isTag(e)).map(e => e.toMarkdown()).join('\n\n').trim();
        const params = doc.getTags('param').map(t => paramTag(t)).filter((t): t is [string, string] => t !== undefined)
            .map(([name, about]) => `- \`${name}\`: ${about}`);
        return [text, params.length > 0 ? params.join('\n') : ''].filter(Boolean).join('\n\n') || undefined;
    }

    /**
     * A parameter: its own doc comment, else the `@param` line of its element, component or function; for a
     * parameter of an enumeration type also the values and what they mean.
     */
    protected parameterDoc(param: Parameter): string | undefined {
        const own = this.documentationProvider.getDocumentation(param);
        const owner = param.$container;
        const tag = owner ? this.jsdoc(owner)?.getTags('param').map(t => paramTag(t)).find(t => t?.[0] === param.name)?.[1] : undefined;
        const type = this.types.declaredType(param.type);
        const inner = type.kind === 'optional' ? type.inner : type;
        const decl = inner.kind === 'enum' && isEnumDecl(inner.decl) ? inner.decl : undefined;
        return [own ?? tag, decl ? this.enumValues(decl) : undefined].filter(Boolean).join('\n\n') || undefined;
    }

    /** The values of an enumeration, each with the first sentence of its doc comment. */
    protected enumValues(decl: EnumDecl): string {
        return decl.members.map(m => {
            const about = this.jsdoc(m)?.elements.filter(e => !isTag(e)).map(e => e.toString()).join(' ').trim();
            return `- \`${m.name}\`${about ? ': ' + firstSentence(about) : ''}`;
        }).join('\n');
    }

    protected signature(node: AstNode): string | undefined {
        const type = (n: AstNode) => printType(this.types.typeOfDeclaration(n));
        if (isComponent(node)) {
            const response = node.responseType ? `: response ${printType(this.types.declaredType(node.responseType))}` : '';
            return `component ${node.name}(${params(node.parameters)})${response}`;
        }
        if (isElementDecl(node)) {
            const events = node.events.length > 0 ? `\n  events ${node.events.map(e => e.name).join(', ')}` : '';
            return `element ${node.name}${typeParams(node.typeParameters)}(${params(node.parameters)})${node.acceptsChildren ? ' { … }' : ''}${events}`;
        }
        if (isFunctionDecl(node)) {
            return `fn ${node.name}${typeParams(node.typeParameters)}(${params(node.parameters)}): ${node.returnType.$cstNode?.text ?? ''}`;
        }
        if (isItem(node)) return `item ${node.name}${node.title ? ' "' + node.title + '"' : ''}`;
        if (isBooklet(node)) {
            const parts = node.body.filter(s => builtinElementOf(s) === 'part');
            const items = AstUtils.streamAllContents(node).filter(n => itemRefOf(n) !== undefined).count();
            return `booklet ${node.name}${node.title ? ' "' + node.title + '"' : ''}\n  ${parts.length} Teil(e), ${items} Aufgabe(n)`;
        }
        if (isParameter(node)) return `(Parameter) ${param(node)}`;
        if (isStateDecl(node)) return `state ${node.name}: ${type(node)}`;
        if (isLetDecl(node)) return `let ${node.name}: ${type(node)}`;
        if (isForVariable(node)) return `(Schleifenvariable) ${node.name}: ${type(node)}`;
        if (isBinding(node)) {
            const owner = AstUtils.getContainerOfType(node, isItem);
            return `(Antwort${owner ? ' in ' + owner.name : ''}) ${node.name}: ${type(node)}`;
        }
        if (isCodingRule(node)) return isScoreRule(node) ? `(Score) ${node.name}: ${type(node)}` : `(Kodierregel) ${node.name}`;
        if (isEnumMember(node)) return `${node.$container.name}.${node.name}`;
        return undefined;
    }
}

function isTag(e: unknown): e is JSDocTag {
    return typeof e === 'object' && e !== null && 'name' in e && 'content' in e;
}

/** `@param name text` → [name, text]. */
function paramTag(tag: JSDocTag): [string, string] | undefined {
    const m = /^\s*([A-Za-z_]\w*)\s+([\s\S]*)$/.exec(tag.content.toString());
    return m ? [m[1], m[2].replace(/\s+/g, ' ').trim()] : undefined;
}

function firstSentence(text: string): string {
    const m = /^(.+?[.:])(\s|$)/.exec(text.replace(/\s+/g, ' '));
    return (m ? m[1] : text).replace(/[.:]$/, '');
}

function typeParams(tps: TypeParameter[]): string {
    return tps.length > 0 ? `<${tps.map(t => t.name).join(', ')}>` : '';
}

function params(ps: Parameter[]): string {
    return ps.map(param).join(', ');
}

function param(p: Parameter): string {
    const def = p.defaultValue?.$cstNode ? ` = ${p.defaultValue.$cstNode.text}` : '';
    return `${p.variadic ? '...' : p.isState ? 'state ' : ''}${p.name}: ${p.type.$cstNode?.text ?? ''}${def}`;
}
