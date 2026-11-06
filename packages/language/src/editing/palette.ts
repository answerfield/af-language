import type { PaletteEntry } from '@answerfield/editing';
import { AstUtils, type AstNode, type URI } from 'langium';
import {
    isBinding, isComponent, isElementDecl, isItem, isLetDecl, type Component, type Document, type ElementDecl, type Item,
    type Parameter
} from '../generated/ast.js';
import { isBuiltinUri } from '../builtin/builtins.js';
import { isRequired, printType } from '../type-system.js';
import { folderDistance } from '../item-scope.js';
import type { ItemServices } from '../item-module.js';

export type { PaletteEntry } from '@answerfield/editing';

/**
 * Palette groups for prelude elements and std shapes. Components with a response go to "Aufgabentypen", components
 * from the workspace to "Eigene Bausteine". Anything not usable inside an item (booklet, versions, stateful atoms)
 * is omitted.
 */
const GROUPS: Record<string, string[]> = {
    'Text und Aufbau': ['p', 'section', 'page', 'box', 'list', 'row', 'group', 'stimulus', 'table', 'cell', 'lines'],
    'Ablauf und Medien': ['show', 'Listen', 'Play', 'media', 'timer', 'flow'],
    'Ebene': ['plane', 'dot', 'caption', 'polygon', 'segment', 'line', 'right_angle', 'tick', 'sector'],
    'Messen und Zeichnen': ['Ruler', 'SetSquare']
};
const ORDER = ['Aufgabentypen', ...Object.keys(GROUPS), 'Eigene Bausteine'];

/** Templates with meaningful content; building blocks without one get placeholders for their required parameters. */
const PRESETS: Record<string, string> = {
    p: 'p "Text"',
    section: 'section(heading: "Überschrift") {\n  p "Text"\n}',
    page: 'page {\n  p "Text"\n}',
    box: 'box {\n  p "Text"\n}',
    list: 'list {\n  "Erster Eintrag"\n  "Zweiter Eintrag"\n}',
    row: 'row {\n  p "Links"\n  p "Rechts"\n}',
    group: 'group(label: "Gruppe") {\n  p "Text"\n}',
    stimulus: 'stimulus {\n  p "Material"\n}',
    table: 'table {\n  row(head: true) { cell "Spalte 1" cell "Spalte 2" }\n  row { cell "" cell "" }\n}',
    cell: 'cell ""',
    lines: 'lines {\n  "Erste Zeile"\n  "Zweite Zeile"\n}',
    show: 'show(when: true) {\n  p "Text"\n}',
    Listen: 'Listen(src: "audio.mp3", plays: 2, prepare: 30s, pause: 10s, finish: 30s)',
    Play: 'Play(src: "audio.mp3", plays: 2)',
    media: 'media(src: "video.mp4", captions: "video.vtt")',
    timer: 'timer(duration: 2min, label: "Bearbeitungszeit")',
    flow: 'flow(navigation: true)',
    plane: 'plane(x: 0 .. 8, y: 0 .. 6, grid: 1, x_axis: "x", y_axis: "y") {\n  dot(at: (2 | 2), label: "A")\n}',
    dot: 'dot(at: (1 | 1), label: "P")',
    caption: 'caption(at: (1 | 1), text: "Text")',
    polygon: 'polygon(points: [(1 | 1), (4 | 1), (2 | 3)])',
    segment: 'segment(from: (1 | 1), to: (4 | 1))',
    line: 'line(a: (1 | 1), b: (4 | 2))',
    right_angle: 'right_angle(vertex: (1 | 1), a: (3 | 1), b: (1 | 3))',
    Choice: 'Choice(label: "Frage", options: ["Antwort A", "Antwort B", "Antwort C"])',
    Gap: 'Gap(label: "Lücke")',
    FreeText: 'FreeText(label: "Antwort")'
};

/** Placeholder source text for a parameter, chosen by name, then by type. */
function placeholder(p: Parameter, type: string): string {
    const base = type.replace(/\?$/, '');
    const texts: Record<string, string> = { label: '"Frage"', heading: '"Überschrift"', title: '"Titel"', alt: '"Beschreibung"', src: '"datei.png"', text: '"Text"' };
    if ((base === 'Content' || base === 'Text') && texts[p.name]) return texts[p.name];
    switch (base) {
        case 'Content': case 'Text': return '"Text"';
        case 'Int': return ['cols', 'rows', 'parts', 'length', 'size'].includes(p.name) ? '4' : '1';
        case 'Rational': return '1';
        case 'Bool': return 'false';
        case 'Size': return '6em';
        case 'Duration': return '5s';
        case 'Point': return '(1 | 1)';
    }
    if (base.startsWith('Interval')) return '0 .. 10';
    if (base.startsWith('List<Point')) return '[(1 | 1), (4 | 1), (2 | 3)]';
    if (base.startsWith('List<Content') || base.startsWith('List<Text')) return '["A", "B"]';
    if (base.startsWith('List<')) return '[1, 2]';
    if (base.startsWith('Set<')) return '{}';
    return 'none';
}

function callables(services: ItemServices): Array<ElementDecl | Component> {
    return services.shared.workspace.LangiumDocuments.all
        .flatMap(d => (d.parseResult.value as Document).elements)
        .filter((e): e is ElementDecl | Component => isElementDecl(e) || isComponent(e))
        .toArray();
}

function isOwn(node: AstNode): boolean {
    return !isBuiltinUri(AstUtils.getDocument(node).uri);
}

/**
 * Whether a component in folder `dir` belongs to the project of a document in folder `from`: the same folder, a
 * subfolder or a parent folder (neighbouring folders, e.g. another year's import, do not).
 */
function related(from: string, dir: string): boolean {
    return from.startsWith(dir) || dir.startsWith(from);
}

/**
 * Building blocks that can be inserted into an item, grouped and sorted. With `from` (the edited document), own
 * components come from its folder, subfolders and parent folders only, the nearest of equal names first; components
 * marked `@intern` in their doc comment (e.g. generated by the importer for one item) are left out.
 */
export function paletteOf(services: ItemServices, from?: URI): PaletteEntry[] {
    const docs = services.documentation.DocumentationProvider;
    const comments = services.documentation.CommentProvider;
    const types = services.types.TypeSystem;
    const grouped = new Map(Object.entries(GROUPS).flatMap(([g, names]) => names.map(n => [n, g])));
    const entries: PaletteEntry[] = [];
    const seen = new Set<string>();
    const folder = (uri: URI) => uri.path.slice(0, uri.path.lastIndexOf('/') + 1);
    const candidates = callables(services).filter(c => {
        if (!isOwn(c)) return true;
        if (/@intern\b/.test(comments.getComment(c) ?? '')) return false;
        return !from || related(folder(from), folder(AstUtils.getDocument(c).uri));
    });
    if (from) candidates.sort((a, b) => folderDistance(from, AstUtils.getDocument(a).uri) - folderDistance(from, AstUtils.getDocument(b).uri));
    for (const c of candidates) {
        if (seen.has(c.name)) continue;
        const own = isOwn(c);
        const response = isComponent(c) && types.responseType(c) !== undefined;
        const group = own ? 'Eigene Bausteine' : response ? 'Aufgabentypen' : grouped.get(c.name);
        if (!group) continue;
        seen.add(c.name);
        const doc = docs.getDocumentation(c)?.replace(/\s*@intern\b/g, '');
        entries.push({
            name: c.name, group, response, own,
            container: c.acceptsChildren === true,
            ...(doc ? { doc: doc.split(/\n\s*\n|(?<=\.)\s/)[0].trim() } : {})
        });
    }
    return entries.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group)
        || (GROUPS[a.group] ? GROUPS[a.group].indexOf(a.name) - GROUPS[b.group].indexOf(b.name) : a.name.localeCompare(b.name)));
}

/** Names already taken in an item (responses, let, parameters). */
export function takenNames(item: Item | undefined): Set<string> {
    if (!item) return new Set();
    const names = AstUtils.streamAllContents(item).filter(n => isBinding(n) || isLetDecl(n)).map(n => (n as { name: string }).name).toSet();
    item.parameters.forEach(p => names.add(p.name));
    return names;
}

/** Free snake_case name following `choice`, `choice2`, …; adds the result to `taken`. */
export function freeName(base: string, taken: Set<string>): string {
    const stem = base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'antwort';
    let name = stem;
    for (let i = 2; taken.has(name); i++) name = `${stem}${i}`;
    taken.add(name);
    return name;
}

/**
 * Source text for a new building block at `target`; components with a response are bound to a free name inside an
 * item. Inside a component there are no bindings: the call stands alone. The nearest declaration of the name wins.
 */
export function templateFor(services: ItemServices, name: string, target: AstNode): string {
    const from = AstUtils.getDocument(target).uri;
    const callable = callables(services).filter(c => c.name === name)
        .sort((a, b) => folderDistance(from, AstUtils.getDocument(a).uri) - folderDistance(from, AstUtils.getDocument(b).uri))[0];
    if (!callable) throw new Error(`Baustein '${name}' gibt es nicht.`);
    return callTemplate(services, callable, AstUtils.getContainerOfType(target, isComponent) ? undefined : itemOf(target) ?? null);
}

/** Call with sample arguments; `item`: bind a response to a free name in it (`null`: an item without names yet). */
export function callTemplate(services: ItemServices, callable: ElementDecl | Component, item?: Item | null): string {
    const name = callable.name;
    const types = services.types.TypeSystem;
    let call = PRESETS[name];
    if (!call) {
        const args = callable.parameters.filter(p => isRequired(p) && !p.isState && !p.variadic)
            .map(p => `${p.name}: ${placeholder(p, printType(types.declaredType(p.type)))}`);
        call = `${name}${args.length > 0 || !callable.acceptsChildren ? `(${args.join(', ')})` : ''}${callable.acceptsChildren ? ' {\n  "Text"\n}' : ''}`;
    }
    const response = isComponent(callable) && types.responseType(callable) !== undefined;
    return response && item !== undefined ? `${freeName(name, takenNames(item ?? undefined))} = ${call}` : call;
}

/** Preview items for the components of a file (see compileForEditor in the compiler): one per component. */
export function previewSource(services: ItemServices, components: Component[]): string {
    return components.map((c, i) => {
        const call = callTemplate(services, c, null).split('\n').map(l => `  ${l}`).join('\n');
        return `item vorschau_${i + 1} ${JSON.stringify(c.name)} {\n${call}\n}\n`;
    }).join('\n');
}

/** The item a node belongs to (the node itself if it is an item). */
export function itemOf(node: AstNode): Item | undefined {
    return isItem(node) ? node : AstUtils.getContainerOfType(node, isItem);
}
