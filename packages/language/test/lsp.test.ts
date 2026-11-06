import { TextDocument } from 'vscode-languageserver-textdocument';
import { beforeAll, describe, expect, test } from 'vitest';
import { setup } from './helpers.js';

let env: Awaited<ReturnType<typeof setup>>;

beforeAll(async () => {
    env = await setup();
});

async function formatted(source: string): Promise<string> {
    const [{ document }] = await env.validate(source);
    const edits = await env.services.Item.lsp.Formatter!.formatDocument(document, {
        textDocument: { uri: document.uri.toString() },
        options: { tabSize: 2, insertSpaces: true }
    });
    return TextDocument.applyEdits(document.textDocument, edits);
}

async function hover(source: string, marker: string): Promise<string> {
    const offset = source.indexOf(marker);
    const [{ document }] = await env.validate(source.replace(marker, ''));
    const result = await env.services.Item.lsp.HoverProvider!.getHoverContent(document, {
        textDocument: { uri: document.uri.toString() },
        position: document.textDocument.positionAt(offset)
    });
    return result && typeof result.contents === 'object' && 'value' in result.contents ? result.contents.value : '';
}

describe('Formatter', () => {
    test('rückt Blöcke ein und lässt einzeilige Blöcke einzeilig', async () => {
        expect(await formatted(`component Shade(parts: Int): response Int {
state shaded: Set<Int> = {}
    group(role: group, label: "x") {
for i in 1 .. parts { toggle(checked: i in shaded,label: "Teil",
             on check:   shaded := shaded + {i}) {   sector(i, of: parts)   } }
  }
      response size(shaded) }`)).toBe(`component Shade(parts: Int): response Int {
  state shaded: Set<Int> = {}
  group(role: group, label: "x") {
    for i in 1 .. parts {
      toggle(checked: i in shaded,label: "Teil",
             on check:   shaded := shaded + {i}) { sector(i, of: parts) }
    }
  }
  response size(shaded)
}`);
    });

    test('Kommentare: zwischen Anweisungen eingerückt, in Argumentlisten unverändert', async () => {
        expect(await formatted(`component Cm(n: Int): response Bool {
state b: Bool = false
      // falsch eingerückter Kommentar
  toggle(checked: b,
         // ausgerichteter Kommentar im Aufruf
         label: "x")
  response b
}`)).toBe(`component Cm(n: Int): response Bool {
  state b: Bool = false
  // falsch eingerückter Kommentar
  toggle(checked: b,
         // ausgerichteter Kommentar im Aufruf
         label: "x")
  response b
}`);
    });

    test('Kodierung: ausgerichtete Fälle bleiben erhalten', async () => {
        const source = `item fmt1 { page { a = FreeText(label: "x") } }

coding fmt1 {
  a: codes(
    code(1, "richtig", score: 1, when: a == "x"),
    code(9, "Rest", when: true)
  )
}`;
        expect(await formatted(source)).toBe(source.replace('item fmt1 { page { a = FreeText(label: "x") } }',
            'item fmt1 {\n  page { a = FreeText(label: "x") }\n}'));
    });

    test('Fließtext: Teile einer Zeile bleiben zusammen, Leerzeilen bleiben', async () => {
        const source = `item fmt3 {
a = Gap("x")

p {
"Der Kak" l6 = Gap("Lücke 6", width: 3ch) "us" sub("6")
      l7 = Gap("Lücke 7") "weiter"
}
}`;
        expect(await formatted(source)).toBe(`item fmt3 {
  a = Gap("x")

  p {
    "Der Kak" l6 = Gap("Lücke 6", width: 3ch) "us" sub("6")
    l7 = Gap("Lücke 7") "weiter"
  }
}`);
    });

    test('Kodierung: Regeln werden eingerückt, ausgerichtete Zeilen bleiben', async () => {
        const source = `item fmt2 {
  a = Gap(label: "x")
  bb = Gap(label: "y")
}

coding fmt2 {
a:  correct(a == "x")
      bb: correct(accept(bb, "(the) y"))
}`;
        expect(await formatted(source)).toBe(`item fmt2 {
  a = Gap(label: "x")
  bb = Gap(label: "y")
}

coding fmt2 {
  a:  correct(a == "x")
  bb: correct(accept(bb, "(the) y"))
}`);
    });
});

describe('Hover', () => {
    test('zeigt den Antworttyp einer Bindung', async () => {
        expect(await hover(`item h1 { page { gr|eater = Choice(label: "a", options: ["1", "2"]) } }`, '|'))
            .toContain('(Antwort in h1) greater: Set<Int>');
    });

    test('zeigt die Signatur einer Bibliothekskomponente mit Dokumentation', async () => {
        const content = await hover(`item h2 { page { x = Ch|oice(prompt: "a", options: ["1"]) } }`, '|');
        expect(content).toContain('component Choice(label: Content?, options: List<Content>, max: Int = 1, state selected: Set<Int> = {}): response Set<Int>');
        expect(content).toContain('Einfach- oder Mehrfachauswahl');
    });

    test('zeigt inferierte Typen von Schleifenvariablen', async () => {
        const content = await hover(`component H3(options: List<Content>) {
          for opt|ion, i in options { p { option } }
        }`, '|');
        expect(content).toContain('option: Content');
    });
});

describe('Schnellkorrekturen', () => {
    async function fix(source: string): Promise<string> {
        const [{ document, diagnostics }] = await env.validate(source);
        const actions = await env.services.Item.lsp.CodeActionProvider!.getCodeActions(document, {
            textDocument: { uri: document.uri.toString() },
            range: diagnostics[0]?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            context: { diagnostics }
        }) ?? [];
        const action = actions.find(a => 'edit' in a && a.edit);
        const edits = action && 'edit' in action ? Object.values(action.edit!.changes!)[0] : [];
        return TextDocument.applyEdits(document.textDocument, edits);
    }

    test('bindet eine ungespeicherte Antwort', async () => {
        expect(await fix(`item qf2 { page { FreeText(label: "x") } }`)).toContain('freeText = FreeText(label: "x")');
    });

    test('ergänzt ein label', async () => {
        expect(await fix(`component Qf3(): response Bool {
  state b: Bool = false
  toggle(checked: b)
  response b
}`)).toContain('toggle(label: "", checked: b)');
    });
});

describe('Gliederung', () => {
    test('zeigt den Aufbau einer Aufgabe mit Bedingung und Kodierung', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const source = readFileSync(join(__dirname, 'fixtures/fractions/fraction1.af'), 'utf8');
        const [{ document }] = await env.validate(source);
        const symbols = await env.services.Item.lsp.DocumentSymbolProvider!.getSymbols(document, { textDocument: { uri: document.uri.toString() } });
        const print = (list: typeof symbols, depth = 0): string[] => list.flatMap(s =>
            [`${'  '.repeat(depth)}${s.name}${s.detail ? ` | ${s.detail}` : ''}`, ...print(s.children ?? [], depth + 1)]);
        expect(print(symbols)).toEqual([
            'item fraction1 | Brüche kürzen',
            '  page',
            '    section',
            '      p',
            '        "Kürze den Bruch 6/8:"',
            '        reduce | Gap',
            '      greater | Choice',
            '    show | greater == {"3/5"}',
            '      section',
            '        reasoning | FreeText',
            'coding fraction1',
            '  reduce | 2 Codes',
            '  greater | greater == {"3/5"}',
            '  total | sum_score(reduce, greater)'
        ]);
        // The selection range of show starts at the element name (used to match nodes with the visual editor)
        const show = symbols[0].children![0].children![1];
        expect(document.textDocument.getText(show.range).startsWith('show(when:')).toBe(true);
    });
});

describe('Arbeitsbereich', () => {
    test('die Quellen der eingebauten Bibliotheken werden nicht ein zweites Mal geladen', async () => {
        const { EmptyFileSystem, URI } = await import('langium');
        const { createItemServices, isLibrarySource } = await import('../src/index.js');
        const manager = createItemServices(EmptyFileSystem).shared.workspace.WorkspaceManager as unknown as {
            shouldIncludeEntry(entry: { uri: InstanceType<typeof URI>; isFile: boolean; isDirectory: boolean }): boolean
        };
        const file = (path: string) => ({ uri: URI.file(path), isFile: true, isDirectory: false });
        expect(manager.shouldIncludeEntry(file('/repo/packages/language/src/builtin/prelude.af'))).toBe(false);
        expect(manager.shouldIncludeEntry(file('/repo/stdlib/std.af'))).toBe(false);
        expect(manager.shouldIncludeEntry(file('/repo/examples/stdlib.af'))).toBe(true);
        expect(manager.shouldIncludeEntry(file('/repo/aufgaben/std.af'))).toBe(true);
        expect(manager.shouldIncludeEntry(file('/repo/aufgaben/prelude.af'))).toBe(true);
        expect(isLibrarySource('C:\\af\\stdlib\\std.af')).toBe(true);
        expect(isLibrarySource('C:\\af\\packages\\language\\src\\builtin\\prelude.af')).toBe(true);
        expect(isLibrarySource('/repo/packages/stdlib/std.af')).toBe(true);
        expect(isLibrarySource('/x/node_modules/@answerfield/stdlib/std.af')).toBe(true);
        expect(isLibrarySource('/x/node_modules/@answerfield/stdlib/prelude.af')).toBe(false);
    });
});

describe('Hover über Aufzählungswerte', () => {
    test('variant(…) und Anpassungen erklären ihre Bedeutung', async () => {
        const easy = await hover(`item hv1 { p { "Lies den Text." variant(easy_lang|uage) "Lies." } }`, '|');
        expect(easy).toContain('Accommodation.easy_language');
        expect(easy).toContain('variant(easy_language) ersetzt den Inhalt');
        const denied = await hover(`item hv2 { deny({read_al|oud}, reason: "misst Lesen") p "x" }`, '|');
        expect(denied).toContain('Accommodation.read_aloud');
        expect(denied).toContain('Vorlesen:');
    });
});

describe('Hover über Parameter', () => {
    test('ein benannter Parameter zeigt seine @param-Zeile und die möglichen Werte', async () => {
        const tone = await hover(`item hp1 { p(to|ne: hint) "x" }`, '|');
        expect(tone).toMatch(/`hint`/);
        expect(tone).toMatch(/`neutral`/);
        const look = await hover(`item hp2 { m = MarkWords(text: "a b", label: "x", lo|ok: underline) }`, '|');
        expect(look).toContain('Art der Markierung');
        expect(look).toMatch(/`underline`/);
    });

    test('die Doku einer Komponente listet ihre Parameter', async () => {
        const gap = await hover(`item hp3 { p { g = G|ap(label: "x") } }`, '|');
        expect(gap).toContain('`width`');
        expect(gap).toContain('Breite der Lücke');
    });
});
