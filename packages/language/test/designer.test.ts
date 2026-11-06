import { AstUtils, type AstNode, type LangiumDocument } from 'langium';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { beforeAll, describe, expect, test } from 'vitest';
import { computeEdit, describeNode, EditError, paletteOf, PSEUDO, type EditIntent } from '../src/index.js';
import { errors, format, setup } from './helpers.js';

let env: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
    env = await setup();
});

async function load(source: string): Promise<LangiumDocument> {
    const [{ document }] = await env.validate(source);
    return document;
}

/** ID of the first node whose source text starts with `prefix`. */
function id(document: LangiumDocument, prefix: string): string {
    const node = AstUtils.streamAst(document.parseResult.value)
        .find((n: AstNode) => n.$cstNode?.text.startsWith(prefix) && n.$type !== 'Reference' && n.$type !== 'Document');
    if (!node) throw new Error(`Kein Knoten beginnt mit ${prefix}`);
    return env.services.Item.workspace.AstNodeLocator.getAstNodePath(node);
}

async function edit(source: string, intent: (d: LangiumDocument) => EditIntent): Promise<{ text: string; selected?: string }> {
    const document = await load(source);
    const result = computeEdit(env.services.Item, document, intent(document));
    const text = TextDocument.applyEdits(document.textDocument, result.edits);
    await env.services.shared.workspace.DocumentBuilder.update([], [document.uri]);
    // The result must still be valid
    const after = await env.diagnosticsOf(text);
    expect(format(errors(after))).toBe('');
    return { text, selected: result.select !== undefined ? text.slice(result.select, result.select + 12) : undefined };
}

const SHADING = `component Shade(parts: Int, label: Content): response Int {
  state n: Int = 0
  toggle(label: label, on check: n := parts)
  response n
}

item d1 "Färben" {
  page {
    section {
      p "Färbe 3/4 des Kreises ein."
      shading = Shade(parts: 8, label: "Kreis")
    }
  }
}`;

describe('Argumente', () => {
    test('Erfolgskriterium 2: parts 8 → 12 ändert genau diese Stelle', async () => {
        const { text, selected } = await edit(SHADING, d => ({ kind: 'setArgument', node: id(d, 'shading ='), param: 'parts', value: '12' }));
        expect(text).toBe(SHADING.replace('parts: 8', 'parts: 12'));
        expect(selected).toBe('shading = Sh');
    });

    test('fehlendes Argument wird angehängt', async () => {
        const { text } = await edit(`item d2 { page { x = FreeText(label: "a") } }`,
            d => ({ kind: 'setArgument', node: id(d, 'x ='), param: 'max', value: '300' }));
        expect(text).toBe(`item d2 { page { x = FreeText(label: "a", max: 300) } }`);
    });

    test('Element ohne Klammern bekommt eine Argumentliste', async () => {
        const { text } = await edit(`item d3 { page { p "Hallo" } }`,
            d => ({ kind: 'setArgument', node: id(d, 'p "Hallo"'), param: 'tone', value: 'hint' }));
        expect(text).toBe(`item d3 { page { p(tone: hint) "Hallo" } }`);
    });

    test('leere Klammern und Positionsargumente', async () => {
        expect((await edit(`item d4 { page { section() { p "x" } } }`,
            d => ({ kind: 'setArgument', node: id(d, 'section()'), param: 'heading', value: '"Teil A"' }))).text)
            .toBe(`item d4 { page { section(heading: "Teil A") { p "x" } } }`);
        expect((await edit(`item d5 { page { plane(x: 0 .. 1) { dot(at: point(0, 0), shape: disc) } } }`,
            d => ({ kind: 'setArgument', node: id(d, 'dot('), param: 'shape', value: 'notch' }))).text)
            .toBe(`item d5 { page { plane(x: 0 .. 1) { dot(at: point(0, 0), shape: notch) } } }`);
    });

    test('einziges Argument entfernen', async () => {
        expect((await edit(`item d6 { page { p(tone: hint) "x" } }`, d => ({ kind: 'removeArgument', node: id(d, 'p('), param: 'tone' }))).text)
            .toBe(`item d6 { page { p() "x" } }`);
    });

    test('Argument entfernen innerhalb einer Liste', async () => {
        const document = await load(`item d7 { page { box(tone: hint, side: end) "x" } }`);
        const first = computeEdit(env.services.Item, document, { kind: 'removeArgument', node: id(document, 'box('), param: 'tone' });
        expect(TextDocument.applyEdits(document.textDocument, first.edits)).toBe(`item d7 { page { box(side: end) "x" } }`);
        const last = computeEdit(env.services.Item, document, { kind: 'removeArgument', node: id(document, 'box('), param: 'side' });
        expect(TextDocument.applyEdits(document.textDocument, last.edits)).toBe(`item d7 { page { box(tone: hint) "x" } }`);
    });

    test('Titel, Bedingung und Text', async () => {
        expect((await edit(`item d8 { page { p "x" } }`, d => ({ kind: 'setArgument', node: id(d, 'item'), param: PSEUDO.title, value: '"Neu"' }))).text)
            .toBe(`item d8 "Neu" { page { p "x" } }`);
        expect((await edit(`item d9 { page { p "Alt" } }`, d => ({ kind: 'setArgument', node: id(d, 'p "Alt"'), param: PSEUDO.text, value: '"Neu"' }))).text)
            .toBe(`item d9 { page { p "Neu" } }`);
    });
});

describe('Löschen, Einfügen, Verschieben', () => {
    const BLOCK = `item e1 {
  page {
    section {
      p "eins"
      // Kommentar bleibt
      p "zwei"
    }
    section { p "drei" }
  }
}`;

    test('Anweisung in eigener Zeile wird mit der Zeile gelöscht', async () => {
        expect((await edit(BLOCK, d => ({ kind: 'delete', node: id(d, 'p "eins"') }))).text).toBe(BLOCK.replace('      p "eins"\n', ''));
    });

    test('Anweisung im einzeiligen Block', async () => {
        const { text } = await edit(`item e2 { page { p { "a " x = Gap(label: "g") } } }`, d => ({ kind: 'delete', node: id(d, '"a "') }));
        expect(text).toBe(`item e2 { page { p { x = Gap(label: "g") } } }`);
    });

    test('Einfügen am Ende, am Anfang, im einzeiligen und leeren Block', async () => {
        expect((await edit(BLOCK, d => ({ kind: 'insert', parent: id(d, 'section {\n'), index: 9, text: 'p "neu"' }))).text)
            .toBe(BLOCK.replace('      p "zwei"\n', '      p "zwei"\n      p "neu"\n'));
        const atStart = await edit(BLOCK, d => ({ kind: 'insert', parent: id(d, 'section {\n'), index: 0, text: 'p "neu"' }));
        expect(atStart.text).toBe(BLOCK.replace('      p "eins"\n', '      p "neu"\n      p "eins"\n'));
        expect(atStart.selected).toBe('p "neu"\n    ');
        expect((await edit(BLOCK, d => ({ kind: 'insert', parent: id(d, 'section { p "drei"'), index: 1, text: 'p "vier"' }))).text)
            .toBe(BLOCK.replace('section { p "drei" }', 'section { p "drei" p "vier" }'));
        expect((await edit(`item e3 { page {} }`, d => ({ kind: 'insert', parent: id(d, 'page'), index: 0, text: 'p "x"' }))).text)
            .toBe(`item e3 { page { p "x" } }`);
    });

    test('mehrzeiliger Inhalt wird eingerückt; einzeiliger Block klappt auf', async () => {
        const { text } = await edit(BLOCK, d => ({ kind: 'insert', parent: id(d, 'section { p "drei"'), index: 1, text: 'section {\n  p "fünf"\n}' }));
        expect(text).toBe(BLOCK.replace('    section { p "drei" }', '    section {\n      p "drei"\n      section {\n        p "fünf"\n      }\n    }'));
    });

    test('Verschieben in einen anderen Block', async () => {
        const { text, selected } = await edit(BLOCK, d => ({ kind: 'move', node: id(d, 'p "eins"'), parent: id(d, 'section { p "drei"'), index: 0 }));
        expect(text).toBe(BLOCK.replace('      p "eins"\n', '').replace('section { p "drei" }', 'section { p "eins" p "drei" }'));
        expect(selected).toBe('p "eins" p "');
    });

    test('Verschieben nach hinten im selben Block', async () => {
        const { text } = await edit(BLOCK, d => ({ kind: 'move', node: id(d, 'p "eins"'), parent: id(d, 'section {\n'), index: 2 }));
        expect(text).toBe(BLOCK.replace('      p "eins"\n      // Kommentar bleibt\n      p "zwei"\n', '      // Kommentar bleibt\n      p "zwei"\n      p "eins"\n'));
    });

    test('ungültige Absichten werden abgelehnt', async () => {
        const document = await load(BLOCK);
        expect(() => computeEdit(env.services.Item, document, { kind: 'delete', node: '/elements@7' })).toThrow(EditError);
        expect(() => computeEdit(env.services.Item, document, { kind: 'move', node: id(document, 'page'), parent: id(document, 'section {\n'), index: 0 })).toThrow(/in sich selbst/);
        expect(() => computeEdit(env.services.Item, document, { kind: 'setArgument', node: id(document, 'p "eins"'), param: 'foo', value: '1' })).toThrow(/keinen Parameter 'foo'/);
    });
});

describe('Beschreibung für das Eigenschaftsformular', () => {
    test('Komponente mit Liste, Zahl und Standardwert', async () => {
        const document = await load(`item f1 { page { pick = Choice(label: "Welche?", options: ["2/5", "3/5"]) } }`);
        const description = describeNode(env.services.Item, document, id(document, 'pick ='))!;
        expect(description).toMatchObject({ label: 'Choice', kind: 'component', binding: 'pick', removable: true });
        expect(description.doc).toContain('Einfach- oder Mehrfachauswahl');
        // the response's coding comes last (see 'Bauen im Editor')
        expect(description.params.filter(p => p.name !== PSEUDO.coding)).toEqual([
            { name: 'label', label: 'label', type: 'Content?', required: false, value: { kind: 'text', value: 'Welche?' } },
            { name: 'options', label: 'options', type: 'List<Content>', required: true, value: { kind: 'list', items: [{ kind: 'text', value: '2/5' }, { kind: 'text', value: '3/5' }] } },
            { name: 'max', label: 'max', type: 'Int', required: false, default: '1' }
        ]);
    });

    test('Atom mit Aufzählung, Ausdruck und Bruch', async () => {
        const document = await load(`component F2(m: Int): response Rational? {
  state v: Rational? = none
  value(bind: v, min: 0, max: 1, step: 1/20, label: "x", role: if m == 1 then slider else spinbutton)
  response v
}`);
        const params = describeNode(env.services.Item, document, id(document, 'value('))!.params;
        expect(params.find(p => p.name === 'step')?.value).toEqual({ kind: 'number', text: '1/20' });
        expect(params.find(p => p.name === 'role')).toMatchObject({ enumValues: ['slider', 'spinbutton'], value: { kind: 'expression', text: 'if m == 1 then slider else spinbutton' } });
        expect(params.some(p => p.name === 'bind')).toBe(false);
    });
});

describe('Palette, Kopie, Punkte, Listen, Tabellen', () => {
    test('Palette aus der Sprache: Aufgabentypen, Aufbau, Ebene; nichts aus Testheft oder mit Zustand', async () => {
        await load(`item pl0 { p "x" }`);
        const palette = paletteOf(env.services.Item);
        const group = (name: string) => palette.find(e => e.name === name)?.group;
        expect(group('Choice')).toBe('Aufgabentypen');
        expect(group('Geoboard')).toBe('Aufgabentypen');
        expect(group('p')).toBe('Text und Aufbau');
        expect(group('polygon')).toBe('Ebene');
        expect(group('segment')).toBe('Ebene');
        for (const absent of ['part', 'versions', 'variant', 'toggle', 'input', 'value']) expect(group(absent)).toBeUndefined();
        expect(palette[0].group).toBe('Aufgabentypen');
        expect(palette.find(e => e.name === 'Gap')).toMatchObject({ response: true, own: false });
    });

    test('Einfügen aus der Palette: Vorlage, freier Antwortname, vor/hinter/in', async () => {
        const source = `item pl1 {\n  page {\n    p "eins"\n    choice = Choice(label: "a", options: ["x"])\n  }\n}`;
        const inside = await edit(source, d => ({ kind: 'create', callable: 'Choice', target: id(d, 'page'), position: 'inside' }));
        expect(inside.text).toContain('    choice2 = Choice(label: "Frage", options: ["Antwort A", "Antwort B", "Antwort C"])\n  }');
        expect(inside.selected).toBe('choice2 = Ch');
        const before = await edit(source, d => ({ kind: 'create', callable: 'p', target: id(d, 'p "eins"'), position: 'before' }));
        expect(before.text).toContain('    p "Text"\n    p "eins"');
        const after = await edit(source, d => ({ kind: 'create', callable: 'table', target: id(d, 'p "eins"'), position: 'after' }));
        expect(after.text).toContain('p "eins"\n    table {\n      row(head: true) { cell "Spalte 1" cell "Spalte 2" }');
        const document = await load(source);
        expect(() => computeEdit(env.services.Item, document, { kind: 'create', callable: 'p', target: id(document, 'p "eins"'), position: 'inside' })).toThrow(/nichts hinein/);
    });

    test('Verschieben vor, hinter und in einen Knoten', async () => {
        const source = `item pl2 {\n  page {\n    p "eins"\n    p "zwei"\n    box {\n      p "drei"\n    }\n  }\n}`;
        expect((await edit(source, d => ({ kind: 'moveTo', node: id(d, 'p "zwei"'), target: id(d, 'p "eins"'), position: 'before' }))).text)
            .toContain('    p "zwei"\n    p "eins"\n');
        expect((await edit(source, d => ({ kind: 'moveTo', node: id(d, 'p "eins"'), target: id(d, 'box'), position: 'inside' }))).text)
            .toContain('    box {\n      p "drei"\n      p "eins"\n    }');
    });

    test('Duplizieren: Antworten und Bezüge darauf bekommen neue Namen', async () => {
        const source = `item pl3 {\n  page {\n    section {\n      a = Choice(label: "x", options: ["ja", "nein"])\n      show(when: a == {1}) { b = Gap("y") }\n    }\n  }\n}`;
        const { text } = await edit(source, d => ({ kind: 'duplicate', node: id(d, 'section') }));
        expect(text).toContain('      a2 = Choice(label: "x", options: ["ja", "nein"])\n      show(when: a2 == {1}) { b2 = Gap("y") }');
        expect(text.match(/section \{/g)).toHaveLength(2);
    });

    test('Punkte: beschreiben und setzen, auch in Listen', async () => {
        const source = `item pl4 {\n  plane(x: 0 .. 8, y: 0 .. 6, grid: 1) {\n    dot(at: point(2, 1), label: "A")\n    polygon(points: [point(1, 1), point(4, 1), point(1/2, -1)])\n  }\n}`;
        const document = await load(source);
        expect(describeNode(env.services.Item, document, id(document, 'dot('))!.points).toEqual([{ param: 'at', x: 2, y: 1, label: 'A' }]);
        expect(describeNode(env.services.Item, document, id(document, 'polygon('))!.points)
            .toEqual([{ param: 'points', index: 0, x: 1, y: 1 }, { param: 'points', index: 1, x: 4, y: 1 }, { param: 'points', index: 2, x: 0.5, y: -1 }]);
        expect((await edit(source.replace('pl4', 'pl4b'), d => ({ kind: 'setPoint', node: id(d, 'dot('), param: 'at', x: '3', y: '2.5' }))).text).toContain('dot(at: (3 | 2.5), label: "A")');
        expect((await edit(source.replace('pl4', 'pl4c'), d => ({ kind: 'setPoint', node: id(d, 'polygon('), param: 'points', index: 1, x: '5', y: '2' }))).text)
            .toContain('polygon(points: [point(1, 1), (5 | 2), point(1/2, -1)])');
    });

    test('Listen: Einträge mit Ausdrücken einzeln, ein Eintrag gezielt ersetzen', async () => {
        const source = `item pl5 { pick = Choice(label: "?", options: ["Hund", image("katze.png", "Katze")]) }`;
        const document = await load(source);
        const options = describeNode(env.services.Item, document, id(document, 'pick ='))!.params.find(p => p.name === 'options')!;
        expect(options.value).toEqual({ kind: 'list', items: [{ kind: 'text', value: 'Hund' }, { kind: 'expression', value: 'image("katze.png", "Katze")' }] });
        expect((await edit(source.replace('pl5', 'pl5b'), d => ({ kind: 'setListItem', node: id(d, 'pick ='), param: 'options', index: 0, value: '"Pferd"' }))).text)
            .toContain('options: ["Pferd", image("katze.png", "Katze")]');
    });

    test('Tabelle: Spalte anhängen; Aktionen in der Beschreibung', async () => {
        const source = `item pl6 {\n  table {\n    row(head: true) { cell "a" }\n    row { cell "1" }\n  }\n}`;
        const document = await load(source);
        expect(describeNode(env.services.Item, document, id(document, 'table'))!.actions).toEqual(['duplicate', 'extract', 'addColumn']);
        const { text } = await edit(source.replace('pl6', 'pl6b'), d => ({ kind: 'addColumn', node: id(d, 'table') }));
        expect(text).toContain('row(head: true) { cell "a" cell "Neue Spalte" }\n    row { cell "1" cell "" }');
    });

    test('Einfügen vor einer Anweisung mit Kommentar: der Kommentar bleibt bei ihr', async () => {
        const source = `item pl7 {\n  page {\n    p "eins"\n    // gehört zu zwei\n    p "zwei"\n  }\n}`;
        const { text } = await edit(source, d => ({ kind: 'create', callable: 'p', target: id(d, 'p "eins"'), position: 'after' }));
        expect(text).toContain('    p "eins"\n    p "Text"\n    // gehört zu zwei\n    p "zwei"');
    });
});


describe('Bauen im Editor', () => {
    test('leere Datei: neue Aufgabe mit Kodierung, neue Komponente', async () => {
        const item = await edit('', () => ({ kind: 'scaffold', what: 'item' }));
        expect(item.text).toMatch(/^item a\d+ "Neue Aufgabe" \{\n  p "Aufgabentext"\n  antwort = Choice\(/);
        expect(item.text).toMatch(/\ncoding a\d+ \{\n  antwort: correct\(antwort == \{1\}\)\n\}\n$/);
        const component = await edit('// Bausteine\n', () => ({ kind: 'scaffold', what: 'component' }));
        expect(component.text).toMatch(/^\/\/ Bausteine\n\n\/\*\* Kurzbeschreibung: .*\*\/\ncomponent A\d+\(label: Content\): response Text \{/);
    });

    const STARS = `component Stars(label: Content): response Int {
  state n: Int = 0
  toggle(label: label, on check: n := 1)
  response n
}`;

    test('Signatur: Doku, Parameter, Antworttyp und children im Formular', async () => {
        const component = (d: LangiumDocument) => id(d, 'component Stars');
        const doc = await edit(STARS, d => ({ kind: 'setArgument', node: component(d), param: PSEUDO.doc, value: 'Sterne vergeben.' }));
        expect(doc.text).toBe(`/** Sterne vergeben. */\n${STARS}`);
        const again = await edit(doc.text, d => ({ kind: 'setArgument', node: component(d), param: PSEUDO.doc, value: '' }));
        expect(again.text).toBe(STARS);
        const params = await edit(STARS, d => ({ kind: 'setArgument', node: component(d), param: PSEUDO.params, value: '[label: Content, max: Int = 5, colors: List<Text> = ["a", "b"]]' }));
        expect(params.text).toContain('component Stars(label: Content, max: Int = 5, colors: List<Text> = ["a", "b"]): response Int {');
        const none = await edit(STARS.replace(/response n|state n.*|, on check: n := 1/g, ''), d => ({ kind: 'setArgument', node: component(d), param: PSEUDO.response, value: '' }));
        expect(none.text).toContain('component Stars(label: Content) {');
        const children = await edit(STARS, d => ({ kind: 'setArgument', node: component(d), param: PSEUDO.children, value: 'true' }));
        expect(children.text).toContain('): response Int children {');
    });

    test('Komponentendatei: Beschreibung zeigt Signatur', async () => {
        const document = await load(STARS);
        const description = describeNode(env.services.Item, document, id(document, 'component Stars'))!;
        expect(description.kind).toBe('component');
        expect(description.params.map(p => p.name)).toEqual([PSEUDO.doc, PSEUDO.params, PSEUDO.response, PSEUDO.children]);
        expect(description.params[1].value).toEqual({ kind: 'list', items: [{ kind: 'expression', value: 'label: Content' }] });
        await env.services.shared.workspace.DocumentBuilder.update([], [document.uri]);
    });

    const QUIZ = `item q1 "Quiz" {
  farbe = Choice(label: "Welche Farbe?", options: ["Rot", "Blau"])
}`;

    test('Kodierung: Vorschläge je Option, anlegen, ändern, entfernen', async () => {
        const document = await load(QUIZ);
        const description = describeNode(env.services.Item, document, id(document, 'farbe ='))!;
        const coding = description.params.find(p => p.name === PSEUDO.coding)!;
        expect(coding.value).toBeUndefined();
        expect(coding.suggestions?.slice(0, 2)).toEqual([
            { value: 'correct(farbe == {1})', label: 'richtig: Rot' }, { value: 'correct(farbe == {2})', label: 'richtig: Blau' }]);
        await env.services.shared.workspace.DocumentBuilder.update([], [document.uri]);

        const set = (text: string, value: string) => edit(text, d => ({ kind: 'setArgument', node: id(d, 'farbe ='), param: PSEUDO.coding, value }));
        const created = await set(QUIZ, 'correct(farbe == {2})');
        expect(created.text).toBe(`${QUIZ}\n\ncoding q1 {\n  farbe: correct(farbe == {2})\n}`);
        const changed = await set(created.text, 'correct(farbe == {1})');
        expect(changed.text).toContain('  farbe: correct(farbe == {1})\n}');
        const removed = await set(changed.text, '');
        expect(removed.text).toBe(`${QUIZ}\n\ncoding q1 {\n}`);
        const added = await set(removed.text, 'correct(farbe == {2})');
        expect(added.text).toBe(`${QUIZ}\n\ncoding q1 {\n  farbe: correct(farbe == {2})\n}`);
    });

    test('Herausziehen: Inhalt wird Komponente, Benutztes wird Parameter; Antworten bleiben', async () => {
        const source = `item x1 "Tiere" {
  let n = 3
  section(heading: "Tiere") {
    p { "Es sind " n " Tiere." }
  }
  a = Gap(label: "Wie viele?")
}`;
        const { text } = await edit(source, d => ({ kind: 'extract', node: id(d, 'section(') }));
        expect(text).toContain('  Baustein(n: n)\n  a = Gap');
        expect(text).toContain('/** Herausgezogen aus x1. */\ncomponent Baustein(n: Int) {\n  section(heading: "Tiere") {\n    p { "Es sind " n " Tiere." }\n  }\n}\n');
        const document = await load(source);
        expect(() => computeEdit(env.services.Item, document, { kind: 'extract', node: id(document, 'a = Gap') })).toThrow(EditError);
        await env.services.shared.workspace.DocumentBuilder.update([], [document.uri]);
    });

    test('Palette in einer Komponente: Aufruf ohne Bindung', async () => {
        const { text } = await edit(STARS, d => ({ kind: 'create', callable: 'Gap', target: id(d, 'toggle('), position: 'after' }));
        expect(text).toContain('  Gap(label: "Lücke")\n  response n');
    });
});

describe('Palette je Ordner', () => {
    test('eigene Komponenten aus Ordner, Unter- und Oberordnern; Nachbarordner und @intern fehlen', async () => {
        const comp = (name: string, doc = '') => `${doc}component ${name}(label: Content) {\n  p "x"\n}`;
        const results = await env.validate(
            { path: 'proj/a/eigen.af', text: comp('Eigen') },
            { path: 'proj/a/unter/tief.af', text: comp('Tief') },
            { path: 'proj/oben.af', text: comp('Oben') },
            { path: 'proj/b/nachbar.af', text: comp('Nachbar') },
            { path: 'proj/a/gen.af', text: comp('Erzeugt', '/** Für eine Aufgabe erzeugt. @intern */\n') },
            { path: 'proj/a/aufgabe.af', text: 'item pa1 { p "x" }' });
        const own = paletteOf(env.services.Item, results[5].document.uri).filter(e => e.own).map(e => e.name);
        expect(own.sort()).toEqual(['Eigen', 'Oben', 'Tief']);
        // without a document: the whole workspace, still without @intern
        const all = paletteOf(env.services.Item).filter(e => e.own).map(e => e.name);
        expect(all).toContain('Nachbar');
        expect(all).not.toContain('Erzeugt');
        await env.services.shared.workspace.DocumentBuilder.update([], results.map(r => r.document.uri));
    });
});
