import { describe, expect, test } from 'vitest';
import { workspace } from './helpers.js';

describe('Compiler', () => {
    test('fraction1: Aufgabe, Komponenten aus std, Kodierung', async () => {
        const { compile } = await workspace();
        const { bundle, errors } = compile('fraction1.af');
        expect(errors).toEqual([]);
        expect(bundle.items.map(i => i.name)).toEqual(['fraction1']);
        expect(Object.keys(bundle.components).sort()).toEqual(['Choice', 'FreeText', 'Gap']);
        expect(bundle.items[0].variables).toEqual([
            { id: 'reduce', type: 'Text', component: 'Gap' },
            { id: 'greater', type: 'Set<Int>', component: 'Choice' },
            { id: 'reasoning', type: 'Text', component: 'FreeText' }
        ]);
        expect(bundle.codings[0].rules.map(r => r.variable)).toEqual(['reduce', 'greater']);
        expect(bundle.codings[0].scores[0]).toEqual({ name: 'total', value: { op: 'meta', fn: 'sum_score', vars: ['reduce', 'greater'] } });
    });

    test('Elemente erhalten alle Parameter, bind und Ereignisse', async () => {
        const { compile } = await workspace();
        const { bundle } = compile('fraction2.af');
        const shading = bundle.components.FractionShading;
        const plane = shading.body.find(n => n.kind === 'element') as unknown as { element: string; children: unknown[] };
        expect(plane.element).toBe('plane');
        const group = plane.children[0];
        expect(group).toMatchObject({ kind: 'element', element: 'group', args: { role: { op: 'enum', value: 'group' } } });
        const loop = (group as { children: unknown[] }).children[0] as { kind: string; body: Array<{ element: string; on: object; args: Record<string, unknown> }> };
        expect(loop.kind).toBe('for');
        // One toggle per part; its shape (the sector) is its content
        const toggle = loop.body[0] as { element: string; on: object; args: Record<string, unknown>; children: Array<{ kind: string; component?: string }> };
        expect(toggle.element).toBe('toggle');
        expect(Object.keys(toggle.on)).toEqual(['check', 'uncheck']);
        expect(toggle.args.disabled).toEqual({ op: 'lit', value: false });
        expect(toggle.children[0]).toMatchObject({ kind: 'component', component: 'sector' });
    });

    test('Dev-Bundle: Hauptdokument ist Quelle 0, IDs nur dort', async () => {
        const { compile } = await workspace({ lib: `item lib1 { page { pick = Choice(label: "a", options: ["x"]) } }` });
        const { bundle } = compile('lib', { dev: true });
        expect(bundle.sources).toEqual(['file:///extra/lib.af', 'af-builtin:/std.af']);
        const page = bundle.items[0].body[0] as { id?: string; children: Array<{ id?: string; src?: number[] }> };
        expect(page.id).toBe('/elements@0/body@0');
        expect(page.children[0]).toMatchObject({ id: '/elements@0/body@0/body@0', src: [0, 19, 60] });
        expect(bundle.components.Choice.body.some(n => 'id' in n && n.id)).toBe(false);
    });

    test('Dev-Bundle: Quellbezug und Fehlerplatzhalter', async () => {
        const { compile } = await workspace({ broken: `item broken { page { p "ok" p { unknown } x = FreeText(label: "a", max: "viel") } }` });
        const { bundle, errors } = compile('broken', { dev: true });
        expect(bundle.sources).toEqual(['file:///extra/broken.af']);
        const page = bundle.items[0].body[0] as { children: Array<{ kind: string; message?: string; src?: unknown }> };
        expect(page.children.map(c => c.kind)).toEqual(['element', 'element', 'error']);
        expect(page.children[2].message).toMatch(/Argument .max./);
        const p = page.children[1] as unknown as { children: Array<{ kind: string; message: string }> };
        expect(p.children[0]).toMatchObject({ kind: 'error', message: "Name 'unknown' ist hier nicht bekannt." });
        expect(page.children[0].src).toEqual([0, 21, 27]);
        expect(errors.length).toBe(2);
    });

    test('Testheft: alle Aufgaben, Instruktionen als Aufgaben ohne Antworten, Kodierungen, Zeit in Sekunden', async () => {
        const { compile } = await workspace();
        const { bundle, errors, documents } = compile('booklet.af');
        expect(errors).toEqual([]);
        expect(bundle.booklets).toEqual([{
            name: 'brueche', title: 'Brüche verstehen',
            accommodations: {
                allow: ['magnification', 'contrast', 'reflow', 'focus_emphasis', 'extended_time', 'read_aloud',
                    'extended_descriptions', 'large_targets', 'reduced_motion', 'switch_access'],
                deny: []
            },
            parts: [
                { name: 'teil1', title: 'Einführung', navigation: 'free', entries: ['brueche.teil1.1'] },
                { name: 'teil2', title: 'Aufgaben', time: 1200, navigation: 'free', entries: ['fraction1', 'fraction2', 'fraction3'] }
            ]
        }]);
        expect(bundle.items.map(i => i.name)).toEqual(['fraction1', 'fraction2', 'fraction3', 'brueche.teil1.1']);
        expect(bundle.items[3]).toMatchObject({ instruction: true, title: 'So funktioniert der Test', variables: [] });
        expect(bundle.codings.map(c => c.item)).toEqual(['fraction1', 'fraction2', 'fraction3']);
        expect(Object.keys(bundle.components).sort()).toEqual(['Choice', 'FractionShading', 'FreeText', 'Gap', 'NumberLine', 'sector', 'tick']);
        expect(documents.some(d => d.endsWith('fraction2.af'))).toBe(true);
    });

    test('Release-Bundle ist deterministisch und ohne Quellbezug', async () => {
        const a = (await workspace()).compile('booklet.af').bundle;
        const b = (await workspace()).compile('booklet.af').bundle;
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        expect(JSON.stringify(a)).not.toMatch(/"src":\[|"id":"\/|"sources"|"dev"/);
    });

    test('Rückmeldung beim Üben: eigener Abschnitt, Kodierung unverändert, für die Testauslieferung weglassbar', async () => {
        const item = `item fb1 { a = Choice("Welche?", ["x", "y", "z"]) b = Gap("Wort") }`;
        const plain = `coding fb1 {
  a: codes(code(1, "richtig", score: 1, when: a == {2}), code(2, "verwechselt", when: a == {3}))
  b: correct(b == "Zähler")
}`;
        const withFeedback = `coding fb1 {
  a: codes(code(1, "richtig", score: 1, when: a == {2}, feedback: "Genau!"),
           code(2, "verwechselt", when: a == {3}, feedback: wording("Du hast x und z verwechselt.", easy: "Schau noch einmal.")),
           otherwise: "Lies die Frage noch einmal.", hints: ["Erster Tipp", "Zweiter Tipp"], solution: "y")
  b: correct(b == "Zähler", right: "Richtig!", wrong: "Oben steht der Zähler.")
}`;
        const a = (await workspace({ fb1: item + plain })).compile('fb1').bundle;
        const b = (await workspace({ fb1: item + withFeedback })).compile('fb1').bundle;
        expect(JSON.stringify(b.codings)).toBe(JSON.stringify(a.codings));
        expect(a.feedback).toBeUndefined();
        const rules = b.feedback![0].rules;
        expect(Object.keys(rules.a.codes!)).toEqual(['1', '2']);
        expect(rules.a.otherwise).toEqual({ op: 'lit', value: 'Lies die Frage noch einmal.' });
        expect(rules.a.hints).toHaveLength(2);
        expect(Object.keys(rules.b.codes!)).toEqual(['0', '1']);
        const test = (await workspace({ fb1: item + withFeedback })).compile('fb1', { noFeedback: true }).bundle;
        expect(test.feedback).toBeUndefined();
        expect(JSON.stringify(test)).toBe(JSON.stringify(a));
    });

    test('Fassungen: Parameter mit Wertebereich, Bedingung, abgeleitete Anpassungen, Fehler', async () => {
        const { compile } = await workspace({
            eggs: `item eggs(per_box: Int = 6, boxes: Int = 4) "Eier" {
              versions(when: per_box in 4 .. 10 and boxes in {2, 3, 4} and per_box * boxes <= 24
                             and not (switch_access in accommodations()))
              deny({read_aloud}, reason: "Rechnen ohne Vorlesen")
              p { "In einen Karton passen " per_box " Eier." }
              total = Gap("Wie viele?")
            }`,
            empty: `item empty(n: Int = 1) { versions(when: n in 1 .. 3 and n > 5) p { n } }`,
            bad: `item bad(n: Int = 5) { versions(when: n in 1 .. 3) p { n } }`
        });
        const { bundle, errors } = compile('eggs');
        expect(errors).toEqual([]);
        const item = bundle.items[0];
        expect(item.params).toEqual([
            { name: 'per_box', type: 'Int', default: 6, values: [4, 5, 6, 7, 8, 9, 10] },
            { name: 'boxes', type: 'Int', default: 4, values: [2, 3, 4] }
        ]);
        expect(item.accommodations).toEqual({ allow: [], deny: ['read_aloud', 'switch_access'], reason: 'Rechnen ohne Vorlesen' });
        expect(item.versions).toBeDefined();
        expect(item.body.some(n => n.kind === 'element' && ['versions', 'deny', 'allow'].includes(n.element))).toBe(false);
        expect(compile('empty').errors.map(e => e.message)).toEqual(['Keine Fassung erfüllt die Bedingung.']);
        expect(compile('bad').errors.map(e => e.message)).toEqual(['Die Standardwerte der Parameter erfüllen die Bedingung nicht.']);
    });
});


describe('Robust beim Tippen', () => {
    test('halbfertige Bindung `x = 5` bringt den Compiler nicht zum Absturz', async () => {
        const { compile } = await workspace({ half: `item half1 { x = 5  y = Gap("a") }` });
        const { bundle } = compile('half');
        expect(bundle.items[0].variables.map(v => v.id)).toEqual(['y']);
    });

    test('eigene Funktionen, vielfach ineinander eingesetzt: Grenze statt riesigem Bundle', async () => {
        const fns = Array.from({ length: 22 }, (_, i) => i === 0 ? 'fn f0(x: Int): Int = x' : `fn f${i}(x: Int): Int = f${i - 1}(x) + f${i - 1}(x)`).join('\n');
        const { compile } = await workspace({ big: `${fns}\nitem big1 { p { f21(1) } }` });
        const started = Date.now();
        const { errors } = compile('big');
        expect(errors.some(e => /zu groß/.test(e.message))).toBe(true);
        expect(Date.now() - started).toBeLessThan(5000);
    });

    test('Fehler der Fassungen sind gewöhnliche Prüfhinweise (registerCompilerChecks)', async () => {
        const { createItemServices, loadBuiltinDocuments } = await import('@answerfield/language');
        const { EmptyFileSystem, URI } = await import('langium');
        const { registerCompilerChecks } = await import('../src/index.js');
        const { shared, Item } = createItemServices(EmptyFileSystem);
        registerCompilerChecks(Item);
        await loadBuiltinDocuments(shared);
        const doc = shared.workspace.LangiumDocumentFactory.fromString(`item vc1(n: Int = 1) { versions(when: n in 1 .. 3 and n > 5) p { n } }`, URI.parse('file:///vc.af'));
        shared.workspace.LangiumDocuments.addDocument(doc);
        await shared.workspace.DocumentBuilder.build([doc], { validation: true });
        expect((doc.diagnostics ?? []).map(d => d.message)).toContain('Keine Fassung erfüllt die Bedingung.');
    });
});

describe('Editor-Vorschau für Komponentendateien', () => {
    test('je Komponente eine Probeaufgabe mit der ID der Komponente; Rumpfknoten sind auswählbar', async () => {
        const { createItemServices, loadBuiltinDocuments, computeEdit } = await import('@answerfield/language');
        const { EmptyFileSystem, URI } = await import('langium');
        const { TextDocument } = await import('vscode-languageserver-textdocument');
        const { compileForEditor } = await import('../src/index.js');
        const { shared, Item } = createItemServices(EmptyFileSystem);
        await loadBuiltinDocuments(shared);
        // The file starts empty and is filled by the "Komponente anlegen" template, as in the editor
        const uri = URI.parse('file:///components/stars.af');
        let document = shared.workspace.LangiumDocumentFactory.fromString('', uri);
        shared.workspace.LangiumDocuments.addDocument(document);
        await shared.workspace.DocumentBuilder.build([document], { validation: true });
        const { edits } = computeEdit(Item, document, { kind: 'scaffold', what: 'component' });
        const text = TextDocument.applyEdits(document.textDocument, edits);
        await shared.workspace.DocumentBuilder.update([], [uri]);
        document = shared.workspace.LangiumDocumentFactory.fromString(text, uri);
        shared.workspace.LangiumDocuments.addDocument(document);
        await shared.workspace.DocumentBuilder.build([document], { validation: true });
        expect(document.diagnostics?.filter(d => d.severity === 1)).toEqual([]);

        const { bundle, errors, documents } = await compileForEditor(Item, document);
        expect(errors).toEqual([]);
        expect(bundle.items).toHaveLength(1);
        expect(bundle.items[0]).toMatchObject({ name: 'Stars', title: 'Vorschau', id: '/elements@0' });
        expect(bundle.items[0].variables).toEqual([{ id: 'stars', type: 'Text', component: 'Stars' }]);
        expect(bundle.sources?.[0]).toBe(uri.toString());
        expect(bundle.components.Stars.body.some(n => n.id?.startsWith('/elements@0/body@'))).toBe(true);
        // the in-memory preview document is neither a workspace document nor an involved one
        expect(documents).toEqual([uri.toString()]);
        expect(shared.workspace.LangiumDocuments.all.toArray().some(d => d.uri.scheme === 'af-preview')).toBe(false);
    });
});
