import { beforeAll, describe, expect, test } from 'vitest';
import type { Diagnostic } from 'vscode-languageserver-types';
import { AstUtils } from 'langium';
import { isReference, type Booklet, type Item } from '../src/generated/ast.js';
import { errors, format, setup } from './helpers.js';

let check: (source: string) => Promise<Diagnostic[]>;

beforeAll(async () => {
    check = (await setup()).diagnosticsOf;
});

async function expectError(source: string, message: RegExp): Promise<void> {
    const diagnostics = await check(source);
    expect(format(errors(diagnostics))).toMatch(message);
}

async function expectNoErrors(source: string): Promise<void> {
    const diagnostics = await check(source);
    expect(format(errors(diagnostics))).toBe('');
}

describe('Typprüfung', () => {
    test('Bedingung muss Bool sein', () => expectError(`
        item t1 { page { show(when: 1 + 2) { p "x" } } }`, /Argument 'when': erwartet Bool, gefunden Int/));

    test('Zuweisung prüft den Zustandstyp', () => expectError(`
        component C(): response Int {
          state n: Int = 0
          toggle(label: "a", on check: n := "zwei")
          response n
        }`, /Zuweisung: erwartet Int, gefunden Text/));

    test('Argumenttypen werden geprüft', () => expectError(`
        item t2 { page { x = FreeText(label: "a", max: "viel") } }`, /Argument 'max': erwartet Int, gefunden Text/));

    test('Antwort passt zum deklarierten Typ', () => expectError(`
        component C(): response Int {
          state t: Text = ""
          input(bind: t, label: "x")
          response t
        }`, /Antwort: erwartet Int, gefunden Text/));

    test('optionale Werte sind nicht ohne Weiteres zuweisbar', () => expectError(`
        component C(): response Rational {
          state pos: Rational? = none
          value(bind: pos, min: 0, max: 1, step: 1/10, label: "x")
          response pos
        }`, /\(Wert kann none sein\)/));

    test('Int / Int ergibt Rational', () => expectNoErrors(`
        component C(): response Rational {
          state r: Rational = 3/4
          input(bind: t, label: "x")
          state t: Text = ""
          response r
        }`));

    test('Generics: value<T> übernimmt den Typ aus bind', () => expectError(`
        component C(): response Rational? {
          state pos: Rational? = none
          value(bind: pos, min: 0, max: "eins", step: 1/10, label: "x")
          response pos
        }`, /Argument 'max': erwartet Rational, gefunden Text/));

    test('unbekannter Typ', () => expectError(`
        component C(x: Foo) { p "x" }`, /Unbekannter Typ 'Foo'/));

    test('Schleife über Nicht-Iterierbares', () => expectError(`
        item t3 { page { for x in "abc" { p "x" } } }`, /kann nicht iteriert werden/));
});

describe('Compiler-Regeln', () => {
    test(':= nur auf eigenem state', () => expectError(`
        item t4 {
          state outer: Int = 0
          page { x = Choice(label: "a", options: ["1"]) }
        }
        component C(): response Int {
          state n: Int = 0
          toggle(label: "a", on check: outer := 1)
          response n
        }`, /Zustand .outer. ist hier nicht bekannt/));

    test('genau ein response', () => expectError(`
        component C(): response Int {
          state n: Int = 0
          toggle(label: "a")
          response n
          response n
        }`, /genau eine 'response'/));

    test('fehlendes response', () => expectError(`
        component C(): response Int { toggle(label: "a") }`, /keine 'response'-Anweisung/));

    test('eindeutige Bindungsnamen', () => expectError(`
        item t5 { page {
          a = FreeText(label: "x")
          section { a = FreeText(label: "y") }
        } }`, /Name 'a' ist in dieser Aufgabe bereits vergeben/));

    test('interaktive Atome brauchen einen zugänglichen Namen', () => expectError(`
        component C(): response Bool {
          state b: Bool = false
          toggle(checked: b)
          response b
        }`, /braucht einen zugänglichen Namen/));

    test('Inhalt eines toggle gilt als Name', () => expectNoErrors(`
        component C(): response Bool {
          state b: Bool = false
          toggle(checked: b) { "Ja" }
          response b
        }`));

    test('radio nur in radiogroup', () => expectError(`
        component C(): response Bool {
          state b: Bool = false
          group(role: group, label: "g") { toggle(role: radio, label: "a") }
          response b
        }`, /Rolle 'radio' ist nur innerhalb einer Gruppe/));

    test('radio mit korrelierten Bedingungen ist erlaubt (Choice)', () => expectNoErrors(`
        component C(max: Int): response Bool {
          state b: Bool = false
          group(role: if max == 1 then radiogroup else group, label: "g") {
            toggle(role: if max == 1 then radio else checkbox, label: "a")
          }
          response b
        }`));

    test('radio bei unkorrelierten Bedingungen wird erkannt', () => expectError(`
        component C(max: Int): response Bool {
          state b: Bool = false
          group(role: if max == 2 then radiogroup else group, label: "g") {
            toggle(role: if max == 1 then radio else checkbox, label: "a")
          }
          response b
        }`, /Rolle 'radio'/));

    test('image braucht alt', () => expectError(`
        item t6 { page { image(src: "a.png") } }`, /Fehlende Pflichtangabe 'alt'/));

    test('Kurzform und Kodierung ohne otherwise sind gültig', () => expectNoErrors(`
        item t7 { page { a = FreeText(label: "x") b = Gap(label: "y") c = Gap(label: "z") } }
        coding t7 {
          a: correct(accept(a, "(the) garden hose", typos: 1))
          b: codes(code(1, when: b == "x"), code(2, "fast", when: b == "y"))
          bc: correct({b, c} == {"säge", "zange"})
          total: sum_score(a, bc)
        }`));

    test('Bedingung einer Kodierregel muss Bool sein', () => expectError(`
        item t7b { page { a = FreeText(label: "x") } }
        coding t7b { a: correct(a) }`, /Argument 'when': erwartet Bool, gefunden Text/));

    test('Teilaufgabe braucht Antworten', () => expectError(`
        item t8 { page { a = FreeText(label: "x") } }
        coding t8 { b: codes(code(1, when: true)) }`, /'b' ist keine Antwort von 't8'; eine Teilaufgabe muss Antworten verwenden/));

    test('Teilaufgabe über nur eine Antwort ist verdächtig (Tippfehler)', async () => {
        const diagnostics = await check(`
            item t8b { page { reduce = Gap(label: "x") } }
            coding t8b { reduse: correct(reduce == "3/4") }`);
        expect(format(diagnostics)).toMatch(/'reduse' ist keine Antwort, sondern eine Teilaufgabe nur über 'reduce'/);
    });

    test('Teilaufgaben haben keinen Wert in Bedingungen', () => expectError(`
        item t8c { page { a = Gap(label: "x") b = Gap(label: "y") } }
        coding t8c {
          ab: correct(a == b)
          a: correct(ab)
        }`, /Teilaufgabe 'ab' hat keinen Wert/));

    test('manual: gültig als Bedingung, auch verknüpft', () => expectNoErrors(`
        item m0 { page { a = Gap(label: "x") k = Choice(label: "?", options: ["ja", "nein"]) } }
        coding m0 {
          a: correct(accept(a, "greenhouse") or not manual("unsinnig", yes: ["Gewächshaus"], no: ["Garage"]))
          ak: codes(code(1, when: k == {1} and manual("Begründung stimmt")), code(2, when: manual("teilweise")))
        }`));

    test('manual nur an Bedingungsstellen einer Kodierung', async () => {
        await expectError(`
            item m1 { page { a = Gap(label: "x") show(when: manual("x")) { p "y" } } }`, /'manual' steht nur als Bedingung einer Kodierung/);
        await expectError(`
            item m2 { page { a = Gap(label: "x") } }
            coding m2 { a: correct(manual("x") == true) }`, /'manual' steht nur als Bedingung einer Kodierung/);
    });

    test('manual: Kriterium und Beispiele als Text', async () => {
        await expectError(`
            item m3 { page { a = Gap(label: "x") } }
            coding m3 { a: correct(manual(a)) }`, /Kriterium als Text angeben/);
        await expectError(`
            item m4 { page { a = Gap(label: "x") } }
            coding m4 { a: correct(manual("x", yes: [a])) }`, /Beispiele als Liste von Texten angeben/);
    });

    test('Tabelle: cell in einer Zeile, Kopfzeile in der Tabelle; Text hinter Auszeichnung', async () => {
        await expectNoErrors(`
            component Line(q: Text) { row { cell { q } cell "…" } }
            item tb0 {
              table(caption: "x") {
                row(head: true) { cell "Frage" cell(span: 2) "Antwort" }
                for q in ["a", "b"] { row { cell { q } cell { p { "Das " emph("ist") " so" } } } }
                Line(q: "c")
              }
              lines(every: 5) { "eins" "zwei" title("drei") }
              m = MarkWords("Ich kam spät", label: "Verben", look: underline)
            }`);
        await expectError(`
            item tb1 { row { cell "x" } }`, /'cell' steht in einer Tabellenzeile/);
        await expectError(`
            item tb2 { row(head: true) { p "x" } }`, /'row\(head: true\)' ist die Kopfzeile einer Tabelle/);
    });

    test('Index: nur bei Listen, ganzzahlig; Teilaufgabe über ein Listenelement ist gewollt', async () => {
        const diagnostics = await check(`
            item ix0 { jobs = Match(rows: ["a", "b"], options: ["x", "y", "z"]) }
            coding ix0 { job1: correct(jobs[1] == 3)  job2: correct(jobs[2] == 1) }`);
        expect(format(diagnostics)).toBe('');
        await expectError(`
            item ix1 { a = Gap(label: "x") }
            coding ix1 { a: correct(a[1] == "y") }`, /Index nur bei Listen möglich, gefunden Text/);
        await expectError(`
            item ix2 { jobs = Match(rows: ["a"], options: ["x"]) }
            coding ix2 { j: correct(jobs["1"] == 1) }`, /Index: erwartet Int, gefunden Text/);
    });

    test('Zeit und Medien: Listen, Play, timer und flow; Dauern; Video ohne Untertitel warnt', async () => {
        await expectNoErrors(`
            item hv0 {
              Listen(src: "https://example.org/a.mp3", plays: 2, prepare: 30s, pause: 10s, finish: 1min)
              Play(src: "https://example.org/a.mp3", from: 192s, to: 220s)
              flow(navigation: heard() >= 2)
              a = Gap("x")
              show(when: heard() >= 3) { b = Gap("y") }
            }`);
        await expectError(`
            item hv1 { Listen(src: "https://example.org/a.mp3", prepare: 30) }`, /Argument 'prepare': erwartet Duration, gefunden Int/);
        const warnings = (await check(`item hv2 { Play(src: "https://example.org/film.mp4") }`)).filter(d => d.severity === 2);
        expect(warnings.map(w => w.message)).toEqual(['Video ohne Untertitel: captions mit einer WebVTT-Datei angeben (für Hörgeschädigte).']);
        expect((await check(`item hv3 { Play(src: "https://example.org/film.mp4", captions: "https://example.org/film.vtt") }`)).filter(d => d.severity === 2)).toEqual([]);
        const two = (await check(`item hv4 { Listen(src: "https://example.org/a.mp3") Listen(src: "https://example.org/b.mp3") }`)).filter(d => d.severity === 2);
        expect(two.map(w => w.message)).toEqual(['Mehrere Listen in einer Aufgabe laufen gleichzeitig; je Aufgabe ein fester Ablauf.']);
        const own = (await check(`component Eigen(state frei: Bool = false) { flow(navigation: frei) }`)).filter(d => d.severity === 2);
        expect(own.map(w => w.message)).toEqual(['Eigener fester Ablauf: in Vergleichstests Listen aus std verwenden, damit er für alle gleich ist.']);
        expect((await check(`component Frist(state over: Bool = false) { flow(locked: over) }`)).filter(d => d.severity === 2)).toEqual([]);
    });

    test('stimulus: direkt in der Aufgabe oder einer Seite', async () => {
        await expectNoErrors(`
            item st0 {
              stimulus(label: "Text") { lines { "eins" "zwei" } }
              page { a = Gap("x") }
              page { stimulus { p "nur hier" } b = Gap("y") }
            }`);
        await expectError(`
            item st1 { section { stimulus { p "x" } } }`, /'stimulus' steht direkt in der Aufgabe/);
    });

    test('Kodierfunktionen für Zahlen und Mengen von Antworten; Rechnen mit optionalen Zahlen', async () => {
        await expectNoErrors(`
            item kf0 {
              a = Gap("x") b = Gap("y") c = Gap("z") why = FreeText("Begründung")
              k = Choice("Tier?", [image("https://example.org/hund.png", "Hund"), "Katze"])
              p { "fröhlich / " + del("frölich") }
            }
            coding kf0 {
              two: correct(accepted([a, b], ["hammer", "pliers"], typos: 1) == 2)
              sum: correct(number(a) + number(b) + number(c) == 36 and number(a) > 0)
              c: correct(proportion(c) == 3/16 or rounds_to(c, 1/7))
              why: correct(k == {1} and manual("Begründung stimmt", about: [why]))
            }`);
        await expectError(`
            item kf1 { a = Gap("x") }
            coding kf1 { a: correct(manual("x", about: ["a"])) }`, /about: Liste von Antworten der Aufgabe/);
    });

    test('Formeln: LaTeX mit einfachem Backslash; Fehler mit Meldung', async () => {
        await expectNoErrors(`
            item fo0 {
              p { "Berechne " math("\\frac{3}{4} + \\frac{1}{8}") ", Strecke " math("\\overline{AB}") }
              k = Choice("Gleichung?", [math("y = 2x + 3"), math("y = x^2")])
            }`);
        await expectError(`item fo1 { p { math("\\frac{3}{") } }`, /Formel: .*expected '\}'/);
        await expectError(`item fo2 { p { math("x" + "y") } }`, /Formel als festen Text angeben/);
    });

    test('Texte: nur \\" und \\\\ sind Escapes, andere Backslashes bleiben', async () => {
        const { setup } = await import('./helpers.js');
        const { validate } = await setup();
        const [{ document }] = await validate('item es0 { p "a\\"b \\\\ c \\frac" }');
        const text = (document.parseResult.value as any).elements[0].body[0].text;
        expect(text).toBe('a"b \\ c \\frac');
    });

    test('Geometrie: Punkte setzen, Darstellung, Koordinaten und Kodierfunktionen', async () => {
        await expectNoErrors(`
            component Square(a: Point?, b: Point?): response List<Point?> {
              state c: Point? = none
              state d: Point? = none
              plane(x: -1 .. 7, y: -1 .. 6, grid: 1, x_axis: "", y_axis: "") {
                polygon(points: [a, b, c, d])
                segment(from: a, to: c) line(a: a, b: b) right_angle(vertex: b, a: a, b: c)
                dot(at: a, label: "A")
                value(bind: c, min: point(-1, -1), max: point(7, 6), step: 1/2, label: "Punkt C", display: "C")
                value(bind: d, min: point(-1, -1), max: point(7, 6), step: 1/2, label: "Punkt D", display: "D")
              }
              response [c, d]
            }
            item geo0 { sq = Square(a: point(1, 1), b: point(4, 1)) }
            coding geo0 {
              sq: correct(distance(sq[1], point(4, 4)) <= 0.1 and is_right_angle(point(1, 1), point(4, 1), sq[1])
                and on_line(sq[2], point(1, 1), point(1, 5)) and area([point(1, 1), point(4, 1), sq[1], sq[2]]) == 9
                and sq[1].x == 4)
            }`);
    });

    test('doppelte Kodierung', () => expectError(`
        item t8d { page { a = Gap(label: "x") } }
        coding t8d { a: correct(a == "1")  a: codes(code(1, when: a == "2")) }`, /'a' ist mehrfach kodiert/));

    test('Rekursion ist verboten', () => expectError(`
        component A() { B() }
        component B() { A() }`, /Rekursion ist nicht erlaubt/));

    test('builtin nur in der Bibliothek', () => expectError(`
        builtin fn foo(): Int`, /'builtin' ist der eingebauten Bibliothek vorbehalten/));

    test('Auffangfall mit true; unbekannte Varianten', async () => {
        await expectNoErrors(`
            item t9 { page { a = FreeText(label: "x") } }
            coding t9 { a: codes(code(1, "richtig", score: 1, when: a == "x"), code(9, "Rest", when: true)) }`);
        const diagnostics = await check(`
            item t9b { page { a = FreeText(label: "x") } }
            coding t9b { a: codes(code(9, "Rest", when: true), code(1, when: a == "x")) }`);
        expect(format(diagnostics)).toMatch(/Fall wird nie erreicht, da ein Fall mit 'when: true' vorher greift/);
        await expectError(`
            item t10 { page { p { "x" variant(kurz) "y" } } }`, /'kurz' gibt es bei Accommodation nicht/);
    });

    test('Fassungen: Parameter brauchen Standardwert und Wertebereich', async () => {
        await expectNoErrors(`
            item v1(per_box: Int = 6, boxes: Int = 4, round: Bool = false) "Eier" {
              versions(when: per_box in 4 .. 10 and boxes in {2, 3, 4} and per_box * boxes <= 50
                             and (not (easy_language in accommodations()) or per_box <= 6))
              p { "In einen Karton passen " per_box " Eier." }
              total = Gap("Wie viele?")
            }
            coding v1 { total: correct(number(total) == per_box * boxes) }`);
        await expectError(`item v2(n: Int = 3) { versions(when: n > 2) p { n } }`, /Wertebereich für 'n' fehlt/);
        await expectError(`item v3(n: Int = 3) { p { n } }`, /Wertebereich für 'n' fehlt/);
        await expectError(`item v4(n: Int) { versions(when: n in 1 .. 3) p { n } }`, /braucht einen Standardwert/);
        await expectError(`item v5(state n: Int = 1) { versions(when: n in 1 .. 3) p { n } }`, /feste Werte, kein Zustand/);
        await expectError(`item v6(n: Int = 1) { versions(when: n in 1 .. 3) n = Gap("x") }`, /bereits vergeben/);
        await expectError(`item v7 { versions(when: true) versions(when: true) p "x" }`, /Nur ein versions/);
    });

    test('bind braucht eigenen Zustand', () => expectError(`
        component C(t: Text): response Text {
          state s: Text = ""
          input(bind: t, label: "x")
          response s
        }`, /'bind' erwartet einen eigenen Zustand/));

    test('Zustände nur in Komponenten, Bindungen nur in Aufgaben, mehrere Handler je Ereignis', async () => {
        await expectError(`item s1 { state x: Int = 0 p "a" }`, /Zustände gehören in Komponenten/);
        await expectError(`
        component S2(): response Text { inner = Gap("x") response "" }`, /Antworten werden in Aufgaben gebunden/);
        await expectNoErrors(`
        component S3(): response Int {
          state a: Int = 0
          state b: Int = 0
          toggle(label: "t", on check: a := 1, on check: b := a + 1)
          response a + b
        }
        item s3 { x = S3() }`);
    });

    test('Kodierung: correct, codes und code nur an ihrem Platz; Scores sind Zahlen; manual nur in when', async () => {
        const items = `item k1 { a = Gap("x") b = Gap("y") }`;
        await expectNoErrors(`${items}
        coding k1 {
          a: correct(accept(a, "x") or manual("sinngemäß x"))
          b: codes(code(1, "voll", score: 2, when: b == "y"), code(2, when: manual("teilweise")))
          total: sum_score(a, b)
        }`);
        // sum_score over responses of different types, in any order
        await expectNoErrors(`item k3 { t = Gap("t") c = Choice("c", ["x", "y"]) }
        coding k3 { t: correct(t == "1") c: correct(c == {2}) total: sum_score(t, c) }`);
        await expectError(`item k2 { show(when: correct(true)) { p "x" } }`, /'correct' ist der Wert einer Kodierregel/);
        await expectError(`${items} coding k1 { a: correct(code(1, when: true) == none) }`, /'code' steht in codes/);
        await expectError(`${items} coding k1 { a: codes(code(1, when: a == "x"), a == "y") }`, /In codes\(…\) stehen Codes/);
        await expectError(`${items} coding k1 { a: sum_score(b) }`, /'a' ist eine Antwort; kodiert wird sie mit correct/);
        await expectError(`${items} coding k1 { total: "viel" }`, /Score: erwartet Rational, gefunden Text/);
        await expectError(`${items} coding k1 { a: correct(a == "x") total: sum_score(a) + (if manual("?") then 1 else 0) }`, /'manual' steht nur als Bedingung/);
    });

    test('eigene Funktionen', async () => {
        await expectNoErrors(`
        fn doppelt(x: Rational?): Rational? = 2 * x
        fn gerade(n: Int): Bool = n / 2 == doppelt(n) / 4
        item f1 { p { "x" } }`);
        await expectError(`fn ohne(x: Int): Int`, /braucht einen Rumpf/);
        await expectError(`fn falsch(x: Int): Text = x + 1`, /Ergebnis: erwartet Text, gefunden Int/);
        await expectError(`fn a(x: Int): Int = b(x)
        fn b(x: Int): Int = a(x)`, /Rekursion ist nicht erlaubt: a → b → a/);
        await expectError(`builtin fn geheim(x: Int): Int`, /'builtin' ist der eingebauten Bibliothek vorbehalten/);
    });

    test('Zustandsparameter', async () => {
        await expectNoErrors(`
        component Pick(options: List<Text>, state chosen: Int? = none): response Int? {
          group(role: radiogroup, label: "Wahl") {
            for o, i in options { toggle(role: radio, label: o, checked: chosen == i, on check: chosen := i) }
          }
          response chosen
        }
        component Rows(n: Int, state all: List<Int?> = repeat(none, n)): response List<Int?> {
          for i in 1 .. n { Pick(options: ["a", "b"], chosen: all[i]) }
          response all
        }
        item sp1 { r = Rows(n: 2) one = Pick(options: ["x"]) }`);
        await expectError(`
        component P1(x: Int) { toggle(label: "a", on check: x := 1) }`, /Parameter 'x' ist nicht änderbar/);
        await expectError(`
        component P2(state x: Int) { p "a" }`, /braucht einen Anfangswert/);
        await expectError(`
        component P3(state x: Int? = none): response Int? { response x }
        component P4(state t: Text = ""): response Text { P3(x: t) response t }`, /passt nicht|erwartet Int\?/);
        await expectError(`
        component P5(state x: Int? = none): response Int? { response x }
        component P6(): response Int? { P5(x: 3) response none }`, /'bind' erwartet einen eigenen Zustand/);
    });

    test('size für Listen und Mengen, image als Inhalt', async () => {
        await expectNoErrors(`
        item sz1 {
          let n = size([1, 2]) + size({3})
          k = Choice("Tier?", [image("https://example.org/hund.png", "Hund", width: 4em), "Katze"])
          p { image("https://example.org/a.png", "Bild") strong(" wichtig") }
        }`);
        await expectError(`item sz2 { let n = size("abc") }`, /Argument 'collection'/);
    });

    test('Komponenten mit Inhalt', async () => {
        await expectNoErrors(`
        component Box1(title: Text) children { section(heading: title) { children } }
        item ch1 { Box1(title: "a") { p "x" } Box1(title: "b") "kurz" }`);
        await expectError(`
        component Box2() { p "x" }
        item ch2 { Box2() { p "y" } }`, /nimmt keinen Inhalt; dafür in der Signatur 'children'/);
        await expectError(`
        component Box3() { children }`, /nimmt keinen Inhalt/);
        await expectError(`
        component Box4(n: Int) children { for i in 1 .. n { children } }`, /nicht in einer Schleife/);
    });

    test('bind an ein Listenelement', async () => {
        await expectNoErrors(`
        component C(): response List<Text> {
          state faces: List<Text> = repeat("", 3)
          for f, i in faces { input(bind: faces[i], label: "Fläche " + i) }
          response faces
        }`);
        await expectError(`
        component D(): response Text {
          state s: Text = ""
          input(bind: s[1], label: "x")
          response s
        }`, /'bind' mit Index erwartet einen Listenzustand/);
    });

    test('Elemente ohne Aufruf', () => expectError(`
        item t12 { page { x = Gap } }`, /^2:31 \[error\] .Gap. muss aufgerufen werden: Gap\(…\)\.$/));

    test('Komponentenantwort ohne Bindung gibt Warnung', async () => {
        const diagnostics = await check(`item t13 { page { FreeText(label: "x") } }`);
        expect(format(diagnostics)).toMatch(/\[warning\] Die Antwort von 'FreeText' wird nicht gespeichert/);
    });
});

describe('Antwortschema', () => {
    test('keine Bindungen in Schleifen', () => expectError(`
        item s1 { page { for i in 1 .. 3 { a = FreeText(label: "x") } } }`, /Antworten in Schleifen sind nicht erlaubt/));
});

describe('Mediendateien', () => {
    test('fehlende Bilddatei neben der Aufgabe wird gemeldet', async () => {
        const { createItemServices, loadBuiltinDocuments } = await import('../src/index.js');
        const { NodeFileSystem } = await import('langium/node');
        const { URI } = await import('langium');
        const services = createItemServices(NodeFileSystem);
        await loadBuiltinDocuments(services.shared);
        const dir = URI.file(`${__dirname}/fixtures`);
        const doc = services.shared.workspace.LangiumDocumentFactory.fromString(
            `item m1 { page { image(src: "missing.png", alt: "x") image(src: "triangle.svg", alt: "y") image(src: "https://x.de/a.png", alt: "z") } }`,
            URI.parse(`${dir.toString()}/m1.af`));
        services.shared.workspace.LangiumDocuments.addDocument(doc);
        await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
        const warnings = (doc.diagnostics ?? []).filter(d => d.severity === 2).map(d => d.message);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/Datei 'missing.png' nicht gefunden/);
    });
});

describe('Sprachstufe neben einer Antwort', () => {
    test('als Text erlaubt, als Block nicht', async () => {
        await expectNoErrors(`item sa1 { p { "Wie viele? " n = Gap("Anzahl") variant(easy_language) "Wie viele sind es? " } }`);
        await expectError(`item sa2 { p { "Wie viele? " n = Gap("Anzahl") variant(easy_language) { p "Wie viele?" } } }`, /ersetzt die Sprachstufe nur den Text davor/);
    });
});

describe('Anpassungen: deny und allow', () => {
    const warnings = async (source: string) => (await check(source)).filter(d => d.severity === 2).map(d => d.message);

    test('deny mit Begründung an der Aufgabe; Stelle und Anzahl', async () => {
        await expectNoErrors(`item r1 { deny({read_aloud, simple_language}, reason: "misst Leseverstehen") p "Lies." }`);
        await expectError(`item r2 { deny({read_aloud}) p "x" }`, /reason/);
        await expectError(`item r2b { p { "x" variant(read_aloud) "y" } }`, /'read_aloud' hat keine Variante/);
        await expectError(`item r3 { page { deny({read_aloud}, reason: "x") p "y" } }`, /'deny' steht direkt in einer Aufgabe/);
        await expectError(`item r4 { deny({read_aloud}, reason: "a") deny({contrast}, reason: "b") p "x" }`, /Nur ein deny/);
        await expectError(`item r5 { deny({vorlesen}, reason: "x") p "y" }`, /vorlesen/);
    });

    test('allow gehört ins Testheft; versions ohne Parameter regelt keine Anpassungen', async () => {
        expect(await warnings(`item r6 { allow({contrast}) p "x" }`)).toEqual([expect.stringMatching(/gehören ins Testheft/)]);
        expect(await warnings(`item r7 { versions(when: not (read_aloud in accommodations())) p "x" }`))
            .toEqual([expect.stringMatching(/regeln deny\(…\) und allow/)]);
        const infos = (await check(`item r8(n: Int = 2) { versions(when: n in 1 .. 9 and (not (easy_language in accommodations()) or n < 5)) p { n } }`))
            .filter(d => d.severity === 3).map(d => d.message);
        expect(infos).toEqual([expect.stringMatching(/leichter oder schwerer/)]);
    });

    test('Varianten, die deny abschaltet, werden gemeldet', async () => {
        expect(await warnings(`item r9 {
            deny({simple_language, easy_language}, reason: "misst Leseverstehen")
            p { "Lies den Text." variant(simple_language) "Lies." variant(easy_language) "Lies." }
            a = Choice(wording("Was stimmt?", simple: "Was ist richtig?"), ["a", "b"])
          }`)).toEqual([
            "Die Variante 'simple_language' wird nie gezeigt: deny(…) schließt die Anpassung aus.",
            "Die Variante 'easy_language' wird nie gezeigt: deny(…) schließt die Anpassung aus.",
            "Die Sprachstufe 'simple' wird nie gezeigt: deny(…) schließt die Anpassung aus."
        ]);
        // Easy language falls back to simple language: without an easy variant, simple stays in effect
        expect(await warnings(`item r10 { deny({simple_language}, reason: "x") p { "Lies den Text." variant(simple_language) "Lies." } }`)).toEqual([]);
    });
});

describe('Testhefte', () => {
    const ITEMS = `item b1 { page { a = FreeText(label: "x") } }
        item b2 { page { p "y" } }`;

    test('gültiges Testheft', () => expectNoErrors(`${ITEMS}
        booklet t1 "Test" {
          allow({contrast, read_aloud})
          deny({switch_access}, reason: "Studie ohne Taster")
          part("p1") { instruction("Start") { p "Los geht's" } }
          part("p2", time: 20min, navigation: forward) { b1 b2 }
        }`));

    test('gleiche Namen in verschiedenen Ordnern: der nächste Ordner gewinnt', async () => {
        const { validate } = await setup();
        const item = (title: string) => `item u1 "${title}" { page { a = Gap(label: "x") } }\ncoding u1 { a: correct(a == "1") }`;
        const [y24, y26, b24, b26, top, dup] = await validate(
            { path: 'ws/2024/u1.af', text: item('2024') },
            { path: 'ws/2026/u1.af', text: item('2026') },
            { path: 'ws/2024/heft.af', text: 'booklet h24 { part("p") { u1 } }' },
            { path: 'ws/2026/heft.af', text: 'booklet h26 { part("p") { u1 } }' },
            { path: 'ws/heft.af', text: 'booklet h { part("p") { u1 } }' },
            { path: 'ws/2026/u1b.af', text: 'item u1 { page { p "y" } }' });
        expect(errors(y24.diagnostics)).toEqual([]);
        const target = (r: typeof b24) => {
            const booklet = r.document.parseResult.value.elements[0] as Booklet;
            const ref = AstUtils.streamAllContents(booklet).filter(isReference).find(r => r.target.$refText === 'u1');
            return (ref?.target.ref as Item | undefined)?.title;
        };
        expect(target(b24)).toBe('2024');
        expect(errors(b24.diagnostics)).toEqual([]);
        // the parent folder sees both years equally far away
        expect(format(errors(top.diagnostics))).toMatch(/'u1' ist mehrdeutig: 2024\/u1.af, 2026\/u1.af/);
        // twice in the same folder stays an error
        expect(format(errors(y26.diagnostics))).toMatch(/'u1' ist mehrfach definiert/);
        expect(format(errors(dup.diagnostics))).toMatch(/'u1' ist mehrfach definiert/);
        expect(b26).toBeDefined();
    });

    test('unbekannte Aufgabe und doppelte Aufgabe', async () => {
        await expectError(`${ITEMS} booklet t2 { part("p1") { b1 b9 } }`, /Name 'b9' ist hier nicht bekannt/);
        await expectError(`${ITEMS} booklet t3 { part("p1") { b1 } part("p2") { b1 } }`, /Aufgabe 'b1' kommt im Testheft mehrfach vor/);
        await expectError(`${ITEMS} item b3 { b1 }`, /Name 'b1' ist hier nicht bekannt/);
    });

    test('Optionen eines Teils werden geprüft', async () => {
        await expectError(`${ITEMS} booklet t4 { part("p1", time: 20) { b1 } }`, /Argument 'time': erwartet Duration/);
        await expectError(`${ITEMS} booklet t5 { part("p1", navigation: backward) { b1 } }`, /backward/);
        await expectError(`${ITEMS} booklet t6 { part("p1", pause: 5min) { b1 } }`, /Parameter 'pause' ist hier nicht bekannt/);
    });

    test('Instruktionen haben keine Antworten; Platzregeln für Teile, Instruktionen und Anpassungen', async () => {
        await expectError(`${ITEMS} booklet t7 { part("p1") { instruction { x = FreeText(label: "a") } b1 } }`, /Instruktionsseiten haben keine Antworten/);
        await expectError(`${ITEMS} booklet t8 { p "x" part("p1") { b1 } }`, /Ein Testheft besteht aus Teilen/);
        await expectError(`item t9 { part("x") { p "y" } }`, /'part' steht in einem Testheft/);
        await expectError(`item t10 { page { versions(when: true) p "y" } }`, /'versions' steht direkt in einer Aufgabe/);
        await expectError(`item t11 { p "a" variant(simple_language) "b" }`, /'variant' steht im Inhalt des Elements/);
        await expectError(`item t12 { stimulus { p "a" variant(easy_language) { p "b" x = Gap("c") } } }`, /In einer Sprachstufe stehen nur Inhalte, keine Antworten/);
        await expectError(`item t13 { p { "a" variant(extended_descriptions) { p "b" p "c" } } }`, /Eine Beschreibung hat genau einen Inhalt/);
        await expectNoErrors(`item t15 { a = Gap("x") } coding t15 { a: correct(a == "1", wrong: "Du hast " + a + " geschrieben.") }`);
        await expectError(`item t15b { a = Gap("x") } coding t15b { a: correct(a == "1", wrong: if changed(a) then "x" else "y") }`, /keine Kodierfunktionen/);
        await expectNoErrors(`item t16 { a = Gap("x") } coding t16 { a: codes(code(1, score: 1, when: a == "1", feedback: "gut"), otherwise: "nochmal", hints: ["h"], solution: "1") }`);
        await expectNoErrors(`item t14 {
          stimulus { p "a" p "b" variant(simple_language) { p "c" } variant(easy_language) { p "d" p { "e " strong("f") } } }
          x = Choice(wording("Frage?", easy: "Leichte Frage?"), ["eins", wording("zwei", simple: "2")])
        }`);
    });

    test('builtin, element und events sind außerhalb des Prelude freie Namen', () => expectNoErrors(`
        item kw1 { page { element = Gap("x")  events = Gap("y")  show(when: element == events) { builtin = Gap("z") } } }
        coding kw1 { element: correct(element == "1") }`));
});


describe('Robust beim Tippen', () => {
    test('let, das von sich selbst abhängt: Fehler statt Endlosschleife', async () => {
        await expectError(`item lc1 { let a = a + 1  p { a } }`, /'a' hängt von sich selbst ab/);
        await expectError(`item lc2 { let a = b  let b = a  p { a } }`, /hängt von sich selbst ab/);
    });

    test('Rekursionssuche bleibt linear bei vielfach geteilten Bausteinen', async () => {
        const levels = 24;
        const comps = Array.from({ length: levels }, (_, i) => i === levels - 1
            ? `component C${i}() { p "x" }`
            : `component C${i}() { A${i}() B${i}() }\ncomponent A${i}() { C${i + 1}() }\ncomponent B${i}() { C${i + 1}() }`).join('\n');
        const started = Date.now();
        await expectNoErrors(`${comps}\nitem rc1 { C0() }`);
        expect(Date.now() - started).toBeLessThan(5000);
    });
});

describe('Punkte in Schulschreibweise', () => {
    test('(x | y) ist ein Punkt, (a + b) bleibt eine Klammer; Koordinaten sind Zahlen', async () => {
        await expectNoErrors(`item pk1 { plane(x: 0 .. 4, y: 0 .. 4) { dot(at: (1 | 2 + 1/2)) polygon(points: [(0 | 0), (4 | 0), ((1 + 1) * 2 | 3)]) } p { (2 + 1) " " (3 | 4).x } }`);
        await expectError(`item pk2 { plane(x: 0 .. 4) { dot(at: ("a" | 1)) } }`, /x-Koordinate: erwartet Rational/);
        await expectError(`item pk3 { p { (1 | 2) + 1 } }`, /Point|Operator/);
    });

    test('point(x, y) bekommt einen Hinweis mit Schnellkorrektur auf (x | y)', async () => {
        const hints = (await check(`item pk4 { plane(x: 0 .. 4) { dot(at: point(1, 2)) dot(at: point(x: 1, y: 2)) } }`)).filter(d => d.severity === 4);
        expect(hints.map(h => h.message)).toEqual(['Punkt kürzer in Schulschreibweise: (x | y).']);
    });

    test('tief verschachtelte Klammern bleiben schnell', async () => {
        const deep = '('.repeat(30) + '1' + ' + 1)'.repeat(30);
        const start = performance.now();
        await expectNoErrors(`item pk5 { p { ${deep} } }`);
        expect(performance.now() - start).toBeLessThan(2000);
    });
});

describe('Optionen per Text', () => {
    test('Auswahl mit Optionstext vergleichen; unbekannte Option und falsche Form werden gemeldet', async () => {
        await expectNoErrors(`item ot1 {
            g = Choice("Welcher Bruch?", ["2/5", "3/5", "1/4"])
            s = Select("Wort", ["Haus", "Baum"])
            show(when: g == {"3/5"}) { p "ok" }
          }
          coding ot1 {
            g: correct(g == {"3/5"} or "1/4" in g)
            s: correct(s == "Baum" or s in {"Haus"})
          }`);
        await expectError(`item ot2 { g = Choice("x", ["a", "b"]) }\ncoding ot2 { g: correct(g == {"c"}) }`, /„c“ ist keine Option. Optionen: „a“, „b“/);
        await expectError(`item ot3 { g = Choice("x", ["a", "b"]) }\ncoding ot3 { g: correct(g == "a") }`, /eine Menge von Optionen: \{"a"\}/);
    });
});

describe('Platzhalter', () => {
    test('unbekannter Name wird gemeldet; in math, accept und accepted gibt es keine Platzhalter', async () => {
        await expectError(`item ph1 { p "Hallo {name}" }`, /Platzhalter \{name\}: 'name' ist hier nicht bekannt/);
        await expectNoErrors(`item ph2 { a = Gap("x") p { math("\\text{cm}") } }\ncoding ph2 { a: correct(accept(a, "{cm}")) }`);
    });
});
