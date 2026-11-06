import type { DropPosition, EditIntent } from '@answerfield/editing';
import { AstUtils, CstUtils, GrammarUtils, UriUtils, type AstNode, type LangiumDocument } from 'langium';
import type { TextEdit } from 'vscode-languageserver-types';
import {
    isBinding, isComponent, isContentStatement, isForStatement, isItem, isLetDecl, isListLiteral, isForVariable, isParameter,
    isReference, isResponseStatement, isStatement, isStringLiteral, type Binding, type Component, type Expression, type Reference, type Statement
} from '../generated/ast.js';
import { builtinElementOf, folderDistance } from '../item-scope.js';
import { isBuiltinUri } from '../builtin/builtins.js';
import { freeName, itemOf, takenNames, templateFor } from './palette.js';
import { codingsOf, ruleOf } from './coding.js';
import { matchArguments, printType } from '../type-system.js';
import type { ItemServices } from '../item-module.js';

export type { EditIntent } from '@answerfield/editing';

/** Text edits for an intent, plus where to put the selection afterwards. */
export interface EditResult {
    edits: TextEdit[];
    /** Offset of the edited or new node in the changed text, used to restore the selection after rebuilding. */
    select?: number;
}

/** An intent that cannot be applied; the message is shown to the user. */
export class EditError extends Error { }

/** Pseudo-parameters for properties that are not call arguments: item title, `for` iterable, text. */
export const PSEUDO = {
    title: '#title', iterable: '#in', text: '#text',
    /** Component signature and documentation */
    doc: '#doc', params: '#params', response: '#response', children: '#children',
    /** Coding rule of a response */
    coding: '#coding'
} as const;

/**
 * Computes the text edits for a visual-editor intent. Only inserted text is formatted;
 * the rest of the document is left untouched.
 */
export function computeEdit(services: ItemServices, document: LangiumDocument, intent: EditIntent): EditResult {
    return new Editor(services, document).apply(intent);
}

/** Node for an ID (Langium AST path). */
export function nodeById(services: ItemServices, document: LangiumDocument, id: string): AstNode | undefined {
    return services.workspace.AstNodeLocator.getAstNode(document.parseResult.value, id);
}

/** The call a statement makes, e.g. `p(…) { … }` or `x = Gap(…)`. */
export function callOf(node: AstNode): Reference | undefined {
    if (isContentStatement(node) && isReference(node.expression)) return node.expression;
    if (isBinding(node) && isReference(node.value)) return node.value;
    return undefined;
}

/** Body of a container that statements can be inserted into; undefined for non-containers. */
export function bodyOf(node: AstNode): Statement[] | undefined {
    if (isItem(node) || isComponent(node) || isForStatement(node)) return node.body;
    if (isContentStatement(node) && node.hasBody) return node.body;
    return undefined;
}

class Editor {
    private readonly text: string;

    constructor(private readonly services: ItemServices, private readonly document: LangiumDocument) {
        this.text = document.textDocument.getText();
    }

    apply(intent: EditIntent): EditResult {
        switch (intent.kind) {
            case 'setArgument': return this.setArgument(this.node(intent.node), intent.param, intent.value);
            case 'removeArgument': return this.removeArgument(this.node(intent.node), intent.param);
            case 'delete': return { edits: [this.edit(this.statementRange(this.statement(intent.node)), '')] };
            case 'insert': return this.insert(this.node(intent.parent), intent.index, intent.text);
            case 'move': return this.move(this.statement(intent.node), this.node(intent.parent), intent.index);
            case 'create': {
                const target = this.node(intent.target);
                const { parent, index } = this.place(target, intent.position);
                let text: string;
                try {
                    text = templateFor(this.services, intent.callable, parent);
                } catch (e) {
                    throw new EditError(e instanceof Error ? e.message : String(e));
                }
                return this.insert(parent, index, text);
            }
            case 'moveTo': {
                const statement = this.statement(intent.node);
                const { parent, index } = this.place(this.node(intent.target), intent.position);
                return this.move(statement, parent, index);
            }
            case 'duplicate': return this.duplicate(this.statement(intent.node));
            case 'setPoint': return this.replaceArgument(this.node(intent.node), intent.param, intent.index, `(${intent.x} | ${intent.y})`);
            case 'setListItem': return this.replaceArgument(this.node(intent.node), intent.param, intent.index, intent.value);
            case 'addColumn': return this.addColumn(this.node(intent.node));
            case 'scaffold': return this.scaffold(intent.what);
            case 'extract': return this.extract(this.statement(intent.node));
        }
    }

    // --- Palette, duplicate, points, tables ---------------------------------------------------

    /** Insertion point: at the end of `target`, or before/after it in the enclosing body. */
    private place(target: AstNode, position: DropPosition): { parent: AstNode; index: number } {
        if (position === 'inside') {
            const body = bodyOf(target);
            if (!body) throw new EditError('Hier kann nichts hinein.');
            // in a component, content goes before its `response`
            const response = isComponent(target) ? body.findIndex(isResponseStatement) : -1;
            return { parent: target, index: response >= 0 ? response : body.length };
        }
        const parent = target.$container;
        const body = parent ? bodyOf(parent) : undefined;
        if (!parent || !body || !isStatement(target)) throw new EditError('Neben der Aufgabe selbst kann nichts stehen.');
        // Index refers to the unchanged text; `move` compensates for the removal itself
        return { parent, index: body.indexOf(target) + (position === 'after' ? 1 : 0) };
    }

    /** Inserts a copy after the original; responses in the copy (and references to them) get fresh names. */
    private duplicate(statement: Statement): EditResult {
        const cst = this.cst(statement);
        const parent = statement.$container;
        const body = bodyOf(parent)!;
        const taken = takenNames(itemOf(statement));
        const bindings = [statement, ...AstUtils.streamAllContents(statement)].filter((n): n is Binding => isBinding(n));
        const renamed = new Map(bindings.map(b => [b, freeName(b.name.replace(/\d+$/, ''), taken)]));
        const replacements: Array<{ start: number; end: number; text: string }> = [];
        for (const [binding, name] of renamed) {
            const n = GrammarUtils.findNodeForProperty(binding.$cstNode, 'name');
            if (n) replacements.push({ start: n.offset, end: n.end, text: name });
        }
        for (const ref of AstUtils.streamAllContents(statement).filter(isReference)) {
            const target = ref.target.ref;
            const n = GrammarUtils.findNodeForProperty(ref.$cstNode, 'target');
            if (isBinding(target) && renamed.has(target) && n) replacements.push({ start: n.offset, end: n.end, text: renamed.get(target)! });
        }
        let copy = cst.text;
        for (const r of replacements.sort((a, b) => b.start - a.start)) {
            copy = copy.slice(0, r.start - cst.offset) + r.text + copy.slice(r.end - cst.offset);
        }
        copy = this.reindent(copy, this.lineIndent(cst.offset), '');
        return this.insert(parent, body.indexOf(statement) + 1, copy);
    }

    /** Replaces argument `param` (or its list element `index`) with the given source text. */
    private replaceArgument(node: AstNode, param: string, index: number | undefined, value: string): EditResult {
        const call = callOf(node);
        const match = call ? matchArguments(call)?.matches.find(m => m.parameter.name === param) : undefined;
        if (!match) throw new EditError(`Argument '${param}' ist nicht angegeben.`);
        let target: Expression = match.argument.value;
        if (index !== undefined) {
            if (!isListLiteral(target) || !target.elements[index]) throw new EditError(`'${param}' hat kein Element ${index + 1}.`);
            target = target.elements[index];
        }
        return { edits: [this.edit(this.range(this.cst(target)), value)], select: node.$cstNode?.offset };
    }

    /** Appends an empty cell to every table row (a titled one to the header row). */
    private addColumn(table: AstNode): EditResult {
        const rows = (bodyOf(table) ?? []).filter(s => builtinElementOf(s) === 'row');
        if (builtinElementOf(table) !== 'table' || rows.length === 0) throw new EditError('Spalten gibt es nur in einer Tabelle mit Zeilen.');
        const edits = rows.map(row => {
            const head = isContentStatement(row) && isReference(row.expression)
                && matchArguments(row.expression)?.matches.some(m => m.parameter.name === 'head' && m.argument.value.$cstNode?.text === 'true');
            return this.insertion(row, bodyOf(row)!.length, head ? 'cell "Neue Spalte"' : 'cell ""').edit;
        });
        return { edits, select: table.$cstNode?.offset };
    }

    // --- Arguments -----------------------------------------------------------------------

    private setArgument(node: AstNode, param: string, value: string): EditResult {
        if (isComponent(node) && param.startsWith('#')) return this.setSignature(node, param, value.trim());
        if (param === PSEUDO.coding && isBinding(node)) return this.setCoding(node, value.trim());
        if (value.trim().length === 0) throw new EditError('Leerer Wert');
        const pseudo = this.pseudoRange(node, param);
        if (pseudo) {
            if (pseudo.insertAfter !== undefined) {
                return { edits: [this.insertAt(pseudo.insertAfter, ` ${value}`)], select: node.$cstNode?.offset };
            }
            return { edits: [this.edit(pseudo, value)], select: node.$cstNode?.offset };
        }
        const call = callOf(node);
        if (!call) throw new EditError('Dieser Knoten hat keine Parameter.');
        const callable = call.target.ref;
        if (!callable || !('parameters' in callable) || !callable.parameters.some(p => p.name === param)) {
            throw new EditError(`'${call.target.$refText}' hat keinen Parameter '${param}'.`);
        }
        const match = matchArguments(call)?.matches.find(m => m.parameter.name === param);
        const select = node.$cstNode?.offset;
        if (match?.argument.value.$cstNode) {
            return { edits: [this.edit(this.range(match.argument.value.$cstNode), value)], select };
        }
        const argument = `${param}: ${value}`;
        if (call.isCall) {
            const last = call.arguments.at(-1)?.$cstNode;
            if (last) return { edits: [this.insertAt(last.end, `, ${argument}`)], select };
            const open = GrammarUtils.findNodeForKeyword(call.$cstNode, '(');
            if (!open) throw new EditError('Argumentliste nicht gefunden.');
            return { edits: [this.insertAt(open.end, argument)], select };
        }
        // `p "…"` or `page { … }`: add the parentheses
        const name = GrammarUtils.findNodeForProperty(call.$cstNode, 'target');
        if (!name) throw new EditError('Elementname nicht gefunden.');
        return { edits: [this.insertAt(name.end, `(${argument})`)], select };
    }

    private removeArgument(node: AstNode, param: string): EditResult {
        const call = callOf(node);
        const match = call ? matchArguments(call)?.matches.find(m => m.parameter.name === param) : undefined;
        if (!call || !match?.argument.$cstNode) throw new EditError(`Argument '${param}' ist nicht angegeben.`);
        const args = call.arguments;
        const index = args.indexOf(match.argument);
        const own = match.argument.$cstNode;
        let start = own.offset, end = own.end;
        if (index < args.length - 1) {
            end = args[index + 1].$cstNode!.offset;          // "a: 1, " up to the next argument
        } else if (index > 0) {
            start = args[index - 1].$cstNode!.end;           // ", b: 2" from the previous argument
        }
        return { edits: [this.edit({ start, end }, '')], select: node.$cstNode?.offset };
    }

    /** Source range of a pseudo-parameter (see {@link PSEUDO}); `insertAfter` marks a missing title. */
    private pseudoRange(node: AstNode, param: string): { start: number; end: number; insertAfter?: number } | undefined {
        if (!param.startsWith('#')) return undefined;
        if (param === PSEUDO.title && isItem(node)) {
            const title = GrammarUtils.findNodeForProperty(node.$cstNode, 'title');
            if (title) return this.range(title);
            const name = GrammarUtils.findNodeForProperty(node.$cstNode, 'name')!;
            return { start: name.end, end: name.end, insertAfter: name.end };
        }
        if (param === PSEUDO.iterable && isForStatement(node) && node.iterable.$cstNode) return this.range(node.iterable.$cstNode);
        if (param === PSEUDO.text && isContentStatement(node)) {
            if (node.text !== undefined) return this.range(GrammarUtils.findNodeForProperty(node.$cstNode, 'text')!);
            if (isStringLiteral(node.expression) && node.expression.$cstNode) return this.range(node.expression.$cstNode);
        }
        throw new EditError(`Eigenschaft '${param}' gibt es hier nicht.`);
    }

    // --- Components: signature, new files, extraction -------------------------------------

    /** Documentation, parameters, response type or `children` of a component declaration. */
    private setSignature(component: Component, param: string, value: string): EditResult {
        const select = component.$cstNode?.offset;
        const cst = this.cst(component);
        if (param === PSEUDO.doc) {
            const comment = CstUtils.findCommentNode(cst, ['ML_COMMENT']);
            // the form sends a string literal
            const plain = /^"[\s\S]*"$/.test(value) ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value;
            const text = plain.trim().replace(/\*\//g, '* /');
            const block = text === '' ? '' : text.includes('\n')
                ? `/**\n${text.split('\n').map(l => ` * ${l}`.trimEnd()).join('\n')}\n */`
                : `/** ${text} */`;
            if (comment) return { edits: [this.edit({ start: comment.offset, end: block === '' ? cst.offset : comment.end }, block)], select };
            if (block === '') return { edits: [], select };
            return { edits: [this.insertAt(cst.offset, `${block}\n${this.lineIndent(cst.offset)}`)], select };
        }
        if (param === PSEUDO.params) {
            const open = GrammarUtils.findNodeForKeyword(cst, '(')!, close = GrammarUtils.findNodeForKeyword(cst, ')')!;
            // the form sends a list "[a: Int, b: Text = "x"]"
            const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
            return { edits: [this.edit({ start: open.end, end: close.offset }, splitTopLevel(inner).join(', '))], select };
        }
        if (param === PSEUDO.response) {
            const close = GrammarUtils.findNodeForKeyword(cst, ')')!;
            const type = component.responseType?.$cstNode;
            if (type) return { edits: [this.edit({ start: close.end, end: type.end }, value === '' ? '' : `: response ${value}`)], select };
            return value === '' ? { edits: [], select } : { edits: [this.insertAt(close.end, `: response ${value}`)], select };
        }
        if (param === PSEUDO.children) {
            const keyword = GrammarUtils.findNodeForKeyword(cst, 'children');
            if (value === 'true' && !keyword) return { edits: [this.insertAt(this.braceOf(component, '{'), 'children ')], select };
            if (value !== 'true' && keyword) return { edits: [this.edit({ start: keyword.offset, end: keyword.end + 1 }, '')], select };
            return { edits: [], select };
        }
        throw new EditError(`Eigenschaft '${param}' gibt es hier nicht.`);
    }

    /** Sets, adds or (empty value) removes the coding rule of a response; creates the coding block if needed. */
    private setCoding(binding: Binding, value: string): EditResult {
        const item = itemOf(binding);
        if (!item) throw new EditError('Kodiert werden nur Antworten einer Aufgabe.');
        const select = binding.$cstNode?.offset;
        const rule = ruleOf(this.services, item, binding.name);
        if (rule && AstUtils.getDocument(rule) !== this.document) throw new EditError('Die Kodierung steht in einer anderen Datei; dort bearbeiten.');
        if (rule) {
            if (value === '') return { edits: [this.edit(this.lineRange(rule), '')], select };
            return { edits: [this.edit(this.range(this.cst(rule.value)), value)], select };
        }
        if (value === '') return { edits: [], select };
        const coding = codingsOf(this.services, item).find(c => AstUtils.getDocument(c) === this.document);
        if (coding) {
            const close = this.braceOf(coding, '}');
            const last = coding.rules.at(-1)?.$cstNode;
            const open = this.braceOf(coding, '{');
            // `{}` on one line gets its own closing line
            const tail = last || this.lineOf(open) !== this.lineOf(close) ? '' : '\n';
            return { edits: [this.insertAt(last ? last.end : open + 1, `\n  ${binding.name}: ${value}${tail}`)], select: close };
        }
        return { edits: [this.insertAt(this.cst(item).end, `\n\ncoding ${item.name} {\n  ${binding.name}: ${value}\n}`)], select };
    }

    /** Appends a new item with coding, or a component, named after the file and free in its folder. */
    private scaffold(what: 'item' | 'component'): EditResult {
        const base = UriUtils.basename(this.document.uri).replace(/\.af$/, '');
        const name = this.freeTopName(what === 'item' ? snake(base) || 'aufgabe' : pascal(base) || 'Baustein');
        const text = what === 'item'
            ? `item ${name} "Neue Aufgabe" {\n  p "Aufgabentext"\n  antwort = Choice(label: "Frage", options: ["Antwort A", "Antwort B", "Antwort C"])\n}\n\n` +
              `coding ${name} {\n  antwort: correct(antwort == {1})\n}\n`
            : `/** Kurzbeschreibung: erscheint in der Palette und beim Überfahren. */\ncomponent ${name}(label: Content): response Text {\n` +
              `  state wert: Text = ""\n  input(bind: wert, label: label)\n  response wert\n}\n`;
        const end = this.text.length;
        const lead = this.text.trim() === '' ? '' : this.text.endsWith('\n\n') ? '' : this.text.endsWith('\n') ? '\n' : '\n\n';
        const start = this.text.trim() === '' ? 0 : end;
        return { edits: [this.edit({ start, end }, lead + text)], select: start + lead.length + (what === 'item' ? 0 : text.indexOf('component')) };
    }

    /**
     * Moves a statement of an item into a new component at the end of the file and calls it in its place. Values it
     * uses from the item (responses, let, parameters, loop variables) become parameters; responses inside cannot
     * move, since components bind no names.
     */
    private extract(statement: Statement): EditResult {
        const item = itemOf(statement);
        if (!item) throw new EditError('Herausziehen geht nur aus einer Aufgabe.');
        const inner = [statement, ...AstUtils.streamAllContents(statement)];
        if (inner.some(isBinding)) throw new EditError('Antworten bleiben in der Aufgabe, nur Inhalt und Darstellung lassen sich herausziehen.');
        const used = new Map<string, string>();
        const types = this.services.types.TypeSystem;
        for (const ref of inner.filter(isReference)) {
            const target = ref.target.ref;
            if (!target || inner.includes(target) || AstUtils.getDocument(target) !== this.document) continue;
            if ((isBinding(target) || isLetDecl(target) || isParameter(target) || isForVariable(target)) && itemOf(target) === item && !used.has(target.name)) {
                used.set(target.name, printType(types.typeOfDeclaration(target)));
            }
        }
        const name = this.freeTopName('Baustein');
        const cst = this.cst(statement);
        const body = this.reindent(cst.text, this.lineIndent(cst.offset), '  ');
        const params = [...used].map(([n, t]) => `${n}: ${t}`).join(', ');
        const component = `\n\n/** Herausgezogen aus ${item.name}. */\ncomponent ${name}(${params}) {\n  ${body}\n}\n`;
        const call = `${name}(${[...used.keys()].map(n => `${n}: ${n}`).join(', ')})`;
        const end = this.text.trimEnd().length;
        return { edits: [this.edit(this.range(cst), call), this.edit({ start: end, end: this.text.length }, component)], select: cst.offset };
    }

    /** A top-level name not yet declared in this folder (`base`, `base2`, …). */
    private freeTopName(base: string): string {
        const here = this.document.uri;
        const taken = new Set(this.services.shared.workspace.IndexManager.allElements()
            .filter(d => folderDistance(here, d.documentUri) === 0 || isBuiltinUri(d.documentUri)).map(d => d.name));
        let name = base;
        for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
        return name;
    }

    /** Range of a node including its whole line(s) when it stands alone. */
    private lineRange(node: AstNode): { start: number; end: number } {
        const { offset, end } = this.cst(node);
        const lineEnd = this.text.indexOf('\n', end);
        if (this.startsLine(offset) && this.text.slice(end, lineEnd < 0 ? undefined : lineEnd).trim() === '') {
            return { start: this.lineStart(offset), end: lineEnd < 0 ? this.text.length : lineEnd + 1 };
        }
        return { start: offset, end };
    }

    // --- Insert and move ---------------------------------------------------------------------

    private insert(parent: AstNode, index: number, text: string): EditResult {
        const { edit, offset } = this.insertion(parent, index, text);
        return { edits: [edit], select: offset };
    }

    private move(statement: Statement, parent: AstNode, index: number): EditResult {
        for (let n: AstNode | undefined = parent; n; n = n.$container) {
            if (n === statement) throw new EditError('Ein Knoten kann nicht in sich selbst verschoben werden.');
        }
        const range = this.statementRange(statement);
        const original = this.reindent(this.cst(statement).text, this.lineIndent(this.cst(statement).offset), '');
        const { edit, offset } = this.insertion(parent, index, original);
        const insertPos = this.document.textDocument.offsetAt(edit.range.start);
        if (insertPos > range.start && insertPos < range.end) throw new EditError('Ungültiges Ziel.');
        const removed = range.end - range.start;
        return {
            edits: [this.edit(range, ''), edit],
            select: insertPos >= range.end ? offset - removed : offset
        };
    }

    /** Insertion with matching indentation; returns the edit and the inserted node's offset in the new text. */
    private insertion(parent: AstNode, index: number, raw: string): { edit: TextEdit; offset: number } {
        const body = bodyOf(parent);
        if (!body) throw new EditError('Hier kann nichts eingefügt werden.');
        const content = body;
        const open = this.braceOf(parent, '{'), close = this.braceOf(parent, '}');
        const parentIndent = this.lineIndent(this.cst(parent).offset);
        const multiLine = this.lineOf(open) !== this.lineOf(close);
        const first = content[0];
        const childIndent = first && this.startsLine(this.cst(first).offset) ? this.lineIndent(this.cst(first).offset) : parentIndent + '  ';
        const text = this.reindent(raw.trim(), '', childIndent);
        const i = Math.max(0, Math.min(index, content.length));

        if (!multiLine && !text.includes('\n')) {
            // A single-line block stays on one line
            if (content.length === 0) return this.at(open + 1, close === open + 1 ? ` ${text} ` : ` ${text}`, 1);
            if (i < content.length) return this.at(this.cst(content[i]).offset, `${text} `, 0);
            return this.at(this.cst(content[content.length - 1]).end, ` ${text}`, 1);
        }
        if (!multiLine) {
            // Multi-line content in a single-line block: expand the block (only its whitespace changes)
            const parts = content.map(s => this.cst(s).text);
            parts.splice(i, 0, text);
            const newText = `{\n${parts.map(p => childIndent + p).join('\n')}\n${parentIndent}}`;
            const offsetInBlock = 2 + parts.slice(0, i).reduce((n, p) => n + childIndent.length + p.length + 1, 0) + childIndent.length;
            return { edit: this.edit({ start: open, end: close + 1 }, newText), offset: open + offsetInBlock };
        }
        if (i < content.length) {
            const target = this.cst(content[i]).offset;
            if (this.startsLine(target)) {
                // Comment lines directly above belong to the statement: insert before them
                const previousEnd = i > 0 ? this.cst(content[i - 1]).end : open + 1;
                let lineStart = this.lineStart(target);
                while (lineStart > previousEnd) {
                    const above = this.lineStart(lineStart - 1);
                    if (above < previousEnd || !this.text.slice(above, lineStart).trim().startsWith('//')) break;
                    lineStart = above;
                }
                return this.at(lineStart, `${childIndent}${text}\n`, childIndent.length);
            }
            return this.at(target, `${text} `, 0);
        }
        const after = content.length > 0 ? this.cst(content[content.length - 1]).end : open + 1;
        return this.at(after, `\n${childIndent}${text}`, 1 + childIndent.length);
    }

    // --- Helpers -------------------------------------------------------------------------

    private node(id: string): AstNode {
        const node = nodeById(this.services, this.document, id);
        if (!node) throw new EditError('Knoten nicht gefunden, das Dokument hat sich geändert.');
        return node;
    }

    private statement(id: string): Statement {
        const node = this.node(id);
        if (!isStatement(node)) throw new EditError('Nur Anweisungen können gelöscht oder verschoben werden.');
        return node;
    }

    private cst(node: AstNode) {
        if (!node.$cstNode) throw new EditError('Knoten ohne Quelltext.');
        return node.$cstNode;
    }

    private braceOf(node: AstNode, brace: '{' | '}'): number {
        const keywords = GrammarUtils.findNodesForKeyword(this.cst(node), brace);
        const k = brace === '{' ? keywords[0] : keywords[keywords.length - 1];
        if (!k) throw new EditError('Block nicht gefunden.');
        return k.offset;
    }

    /** Range of a statement; the whole line if the statement stands alone on it. */
    private statementRange(statement: Statement): { start: number; end: number } {
        const { offset, end } = this.cst(statement);
        const lineStart = this.lineStart(offset);
        const lineEnd = this.text.indexOf('\n', end);
        const restOfLine = this.text.slice(end, lineEnd < 0 ? this.text.length : lineEnd);
        if (this.startsLine(offset) && restOfLine.trim() === '') {
            return { start: lineStart, end: lineEnd < 0 ? this.text.length : lineEnd + 1 };
        }
        // Inline: include adjacent spaces
        let e = end;
        while (this.text[e] === ' ') e++;
        if (e > end) return { start: offset, end: e };
        let s = offset;
        while (s > 0 && this.text[s - 1] === ' ') s--;
        return { start: s, end };
    }

    private range(cst: { offset: number; end: number }): { start: number; end: number } {
        return { start: cst.offset, end: cst.end };
    }

    private lineStart(offset: number): number {
        return this.text.lastIndexOf('\n', offset - 1) + 1;
    }

    private lineOf(offset: number): number {
        return this.document.textDocument.positionAt(offset).line;
    }

    private lineIndent(offset: number): string {
        return /^[ \t]*/.exec(this.text.slice(this.lineStart(offset)))![0];
    }

    private startsLine(offset: number): boolean {
        return this.text.slice(this.lineStart(offset), offset).trim() === '';
    }

    /** Replaces the indentation `from` at the start of every line but the first with `to`. */
    private reindent(text: string, from: string, to: string): string {
        return text.split('\n').map((line, i) => i === 0 ? line : to + (line.startsWith(from) ? line.slice(from.length) : line.trimStart())).join('\n');
    }

    private at(offset: number, newText: string, lead: number): { edit: TextEdit; offset: number } {
        return { edit: this.insertAt(offset, newText), offset: offset + lead };
    }

    private insertAt(offset: number, newText: string): TextEdit {
        return this.edit({ start: offset, end: offset }, newText);
    }

    private edit(range: { start: number; end: number }, newText: string): TextEdit {
        const doc = this.document.textDocument;
        return { range: { start: doc.positionAt(range.start), end: doc.positionAt(range.end) }, newText };
    }
}


/** Splits at commas outside brackets and strings, e.g. `a: Int, b: List<Int> = [1, 2]`; empty parts are dropped. */
export function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0, quote = false, start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) { if (c === '\\') i++; else if (c === '"') quote = false; continue; }
        if (c === '"') quote = true;
        else if ('([{<'.includes(c)) depth++;
        else if (')]}>'.includes(c)) depth = Math.max(0, depth - 1);
        else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    parts.push(text.slice(start));
    return parts.map(p => p.trim()).filter(p => p !== '');
}

/** snake_case from a file name ("Brüche 1" → "brueche_1"); prefixed if it starts with a digit. */
function snake(text: string): string {
    const s = text.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return /^\d/.test(s) ? `a${s}` : s;
}

/** PascalCase from a file name ("sterne_bewertung" → "SterneBewertung"). */
function pascal(text: string): string {
    return snake(text).split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('').replace(/^(\d)/, 'B$1');
}
