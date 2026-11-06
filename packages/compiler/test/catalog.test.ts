import { createRequire } from 'node:module';
import { beforeAll, describe, expect, test } from 'vitest';
import { AstUtils, URI } from 'langium';
import type { Bundle, ElementNode, Expr, Catalog } from '@answerfield/bundle';
import { ast } from '@answerfield/language';
import { META_FUNCTIONS, RESOLVED_BUILTINS } from '../src/index.js';
import { workspace } from './helpers.js';

// The catalog describes what reaches a bundle. prelude.af describes what authors write. Every built-in of the prelude
// is either a catalog entry or resolved by the compiler (RESOLVED_BUILTINS); this test checks the translation from the
// author form into the bundle form, and that every call and element the compiler emits fits a catalog entry.
const catalog: Catalog = createRequire(import.meta.url)('@answerfield/bundle/catalog.json');

type Decl = ast.FunctionDecl | ast.ElementDecl;
type Entry = Catalog['functions'][number] | Catalog['elements'][number];
type Use = ElementNode | Extract<Expr, { op: 'call' | 'meta' }>;

const show = (v: unknown) => (v === undefined ? 'nichts' : JSON.stringify(v));
const labelOf = (d: Decl) => (ast.isElementDecl(d) ? 'Element' : 'Funktion');

/** Built-in functions and elements of prelude.af by name, in declaration order. */
function builtinsOf(document: ast.Document): Map<string, Decl> {
    return new Map(document.elements
        .filter((e): e is Decl => ast.isElementDecl(e) || (ast.isFunctionDecl(e) && e.builtin))
        .map(d => [d.name, d]));
}

/** Type in source notation (the notation of `TypeDesc`). */
function typeText(t: ast.TypeReference): string {
    const args = t.arguments.length > 0 ? `<${t.arguments.map(typeText).join(', ')}>` : '';
    return `${t.name}${args}${t.optional ? '?' : ''}`;
}

/** Parameter of the prelude in the shape of the catalog. */
const parameterOf = (p: ast.Parameter) => ({ name: p.name, type: typeText(p.type), ...(p.variadic ? { variadic: true as const } : {}) });

/** Every built-in of the prelude is in the catalog or in RESOLVED_BUILTINS, never in both; both name only built-ins. */
function coverageProblems(k: Catalog, resolved: ReadonlySet<string>, prelude: Map<string, Decl>): string[] {
    const found: string[] = [];
    const listed = new Map<string, string>([...k.functions.map(f => [f.name, 'Funktion'] as const), ...k.elements.map(e => [e.name, 'Element'] as const)]);
    for (const [name, decl] of prelude) {
        const label = labelOf(decl), inCatalog = listed.get(name);
        if (!inCatalog && !resolved.has(name)) found.push(`${label} '${name}' aus prelude.af steht weder im Katalog noch in RESOLVED_BUILTINS.`);
        if (inCatalog && resolved.has(name)) found.push(`${label} '${name}' steht im Katalog und in RESOLVED_BUILTINS; entweder erreicht der Name das Bundle oder der Compiler löst ihn auf.`);
        if (inCatalog && inCatalog !== label) found.push(`'${name}' ist in prelude.af als ${label} deklariert, im Katalog als ${inCatalog}.`);
    }
    for (const [name, label] of listed) if (!prelude.has(name)) found.push(`${label} '${name}' steht im Katalog, prelude.af deklariert den Namen nicht als eingebaut.`);
    for (const name of resolved) if (!prelude.has(name)) found.push(`'${name}' steht in RESOLVED_BUILTINS, prelude.af deklariert den Namen nicht als eingebaut.`);
    return found;
}

/**
 * How the bundle form may differ from the author form, one message per other difference. Functions keep type
 * parameters, result and every parameter with its type; a new parameter is a `Text` the compiler prepares from the
 * source (`math`: MathML). In the `meta` form the parameters are the names of the response variables (`Text`), without
 * type parameters. Elements keep everything but `bind`, which becomes `binding` with its type.
 */
function translationProblems(k: Catalog, prelude: Map<string, Decl>): string[] {
    const found: string[] = [];
    const differs = (where: string, field: string, catalogValue: unknown, preludeValue: unknown) => {
        if (show(catalogValue) !== show(preludeValue)) found.push(`${where}, ${field}: Katalog ${show(catalogValue)}, prelude.af ${show(preludeValue)}.`);
    };
    for (const [section, label] of [['functions', 'Funktion'], ['elements', 'Element']] as const) {
        const entries: Entry[] = k[section];
        for (const entry of entries) {
            const decl = prelude.get(entry.name);
            if (!decl || labelOf(decl) !== label) continue; // coverageProblems reports it
            const where = `${label} '${entry.name}'`;
            const typeParameters = decl.typeParameters.length > 0 ? decl.typeParameters.map(t => t.name) : undefined;
            const params = decl.parameters.map(parameterOf);
            const canonical = (list: Array<{ name: string; type: string; variadic?: true }>) => list.map(p => ({ name: p.name, type: p.type, ...(p.variadic ? { variadic: true } : {}) }));
            if (ast.isFunctionDecl(decl)) {
                const f = entry as Catalog['functions'][number];
                differs(where, 'result', f.result, typeText(decl.returnType));
                if (f.form === 'meta') {
                    differs(where, 'typeParameters (Form meta)', f.typeParameters, undefined);
                    differs(where, 'parameters (Form meta: Namen der Antwortvariablen)', canonical(f.parameters),
                        params.map(p => ({ name: p.name, type: 'Text', ...(p.variadic ? { variadic: true } : {}) })));
                    continue;
                }
                differs(where, 'typeParameters', f.typeParameters, typeParameters);
                const own = new Map(params.map(p => [p.name, p]));
                for (const p of canonical(f.parameters)) {
                    if (own.has(p.name)) differs(where, `Parameter '${p.name}'`, p, own.get(p.name));
                    else if (p.type !== 'Text') found.push(`${where}: Parameter '${p.name}' gibt es in prelude.af nicht; ein vom Compiler vorbereiteter Wert ist Text, nicht ${p.type}.`);
                }
                const kept = f.parameters.map(p => p.name).filter(n => own.has(n));
                differs(where, 'Parameter aus prelude.af', kept, params.map(p => p.name));
            } else {
                const e = entry as Catalog['elements'][number];
                differs(where, 'typeParameters', e.typeParameters, typeParameters);
                differs(where, 'parameters (ohne bind)', canonical(e.parameters), params.filter(p => p.name !== 'bind'));
                differs(where, 'binding', e.binding, params.find(p => p.name === 'bind')?.type);
                differs(where, 'children', e.children, decl.acceptsChildren);
                differs(where, 'events', e.events ?? [], decl.events.map(ev => ev.name));
            }
        }
        const order = entries.map(e => e.name).filter(n => prelude.has(n));
        const preludeOrder = [...prelude.keys()].filter(n => entries.some(e => e.name === n));
        if (order.join() !== preludeOrder.join()) found.push(`Reihenfolge (${section}): Katalog ${order.join(', ')}; prelude.af ${preludeOrder.join(', ')}.`);
    }
    return found;
}

/** Whether the bundle form of an entry differs from its declaration in the prelude. */
function bundleFormDiffers(entry: Entry, decl: Decl): boolean {
    if ('form' in entry && entry.form) return true;
    if ('binding' in entry && entry.binding) return true;
    return show(entry.parameters.map(p => p.name)) !== show(decl.parameters.map(p => p.name));
}

/** Element nodes, calls and coding functions (`meta`) anywhere in a bundle. */
function usesIn(value: unknown, found: Use[] = []): Use[] {
    if (Array.isArray(value)) value.forEach(v => usesIn(v, found));
    else if (value && typeof value === 'object') {
        const o = value as Record<string, unknown>;
        if (o.kind === 'element' || o.op === 'call' || o.op === 'meta') found.push(o as unknown as Use);
        Object.values(o).forEach(v => usesIn(v, found));
    }
    return found;
}

/**
 * Every use in a bundle that does not fit the catalog, one message each: unknown name; for a function the form (`call`
 * or `meta`) and the number of arguments; for an element the argument names in order, `bind` only with `binding`,
 * events among `events`, content only with `children`.
 */
function useProblems(k: Catalog, bundle: Bundle): string[] {
    return usesIn(bundle).flatMap((use): string[] => {
        if ('kind' in use) {
            const entry = k.elements.find(e => e.name === use.element);
            const where = `Element '${use.element}'`;
            if (!entry) return [`${where} steht im Bundle, der Katalog kennt es nicht.`];
            const found: string[] = [];
            const names = Object.keys(use.args), expected = entry.parameters.map(p => p.name);
            if (show(names) !== show(expected)) found.push(`${where}: Argumente im Bundle ${names.join(', ') || 'keine'}, laut Katalog ${expected.join(', ') || 'keine'}.`);
            if (use.bind !== undefined && !entry.binding) found.push(`${where} bindet im Bundle den Zustand '${use.bind}', laut Katalog bindet es nichts.`);
            if (use.bind === undefined && entry.binding) found.push(`${where} bindet laut Katalog einen Zustand (${entry.binding}), im Bundle fehlt bind.`);
            for (const event of Object.keys(use.on ?? {}).filter(ev => !(entry.events ?? []).includes(ev))) {
                found.push(`${where}: Ereignis '${event}' im Bundle, laut Katalog ${entry.events?.join(', ') || 'keine Ereignisse'}.`);
            }
            if (use.children.length > 0 && !entry.children) found.push(`${where} hat im Bundle Inhalt, laut Katalog nimmt es keinen.`);
            return found;
        }
        const entry = k.functions.find(f => f.name === use.fn);
        const where = `Funktion '${use.fn}'`;
        if (!entry) return [`${where} steht im Bundle (${use.op}), der Katalog kennt sie nicht.`];
        const form = entry.form ?? 'call';
        if (use.op !== form) return [`${where}: im Bundle als ${use.op}, laut Katalog als ${form}.`];
        const count = use.op === 'meta' ? use.vars.length : use.args.length;
        const fixed = entry.parameters.filter(p => !p.variadic).length;
        const fits = entry.parameters.some(p => p.variadic) ? count >= fixed : count === fixed;
        return fits ? [] : [`${where} (${use.op}): im Bundle ${count} Argument(e), laut Katalog ${entry.parameters.map(p => p.name).join(', ') || 'keine'}.`];
    });
}

// Uses every catalog entry. Media sources are URLs, so no asset files are needed.
const EVERY_ENTRY = `
component Alles() {
  state s: Text = ""
  state r: Rational? = none
  state fertig: Bool = false
  stimulus(label: "Material") {
    lines(every: 5, start: 1) { "Zeile eins" "Zeile zwei" }
  }
  section(heading: "Teil") {
    row(gap: 1em) { p "links" p "rechts" }
    group(role: group, label: "Gruppe") {
      toggle(role: checkbox, label: "an", on check: fertig := true) { "Schalter" }
    }
    box(tone: neutral, side: start, heading: "Kasten") { p "Inhalt" }
    list(ordered: true) { "eins" "zwei" }
    table(caption: "Tabelle") { row { cell(span: 2) { "a" } cell { "b" } } }
    timer(duration: 1min, label: "Zeit", on elapsed: fertig := true)
    media(src: "https://example.org/ton.mp3", label: "Ton", on ended: fertig := true)
    flow(navigation: true)
    input(bind: s, label: "Feld", on change: fertig := true)
    plane(x: 0 .. 10, y: 0 .. 10, grid: 1) {
      dot(at: point(1, 2), label: "A")
      caption(at: polar((0 | 0), 2, 45), text: "B")
      polygon(points: [(0 | 0), arc((0 | 0), 3, from: 0, to: 90)])
      value(bind: r, min: 0, max: 10, step: 1, label: "Wert")
    }
    p { wording("Text", simple: "Einfach") " " markup(emphasis, "betont") " " image("https://example.org/bild.png", "Bild") " " math("x^2") }
    p { size(words(normalize(s))) " " heard() " " current_page() " " size(accommodations()) }
    p { if distance((0 | 0), (1 | 1)) == angle((1 | 0), (0 | 0), (0 | 1)) or area([(0 | 0), (1 | 0), (0 | 1)]) == 1 then "ja" else "nein" }
    p { count(repeat(1, 3), 1) " " count_in([1, 2], {1}) " " size(replace([1, 2], 1, 3)) " " size(shape({[(0 | 0), (1 | 0)]})) }
    p { if number(s) == proportion(s) or quantity(s, "cm") == 1 or rounds_to(s, 1, digits: 0) and is_reduced(s) then "ja" else "nein" }
  }
}

item alles {
  page {
    Alles()
    a = Gap("Feld")
    b = Gap("Feld 2")
  }
}

coding alles {
  a: correct(accept(a, "x") and changed(a))
  b: correct(accepted([a, b], ["x", "y"]) >= 1 or displayed(b))
  total: sum_score(a, b)
}`;

// Uses every name the compiler resolves.
const RESOLVED = `
item k1(n: Int = 2) {
  versions(when: n in 1 .. 3)
  deny({read_aloud}, reason: "Grund")
  page {
    p { "Wert {n}" variant(simple_language) "Wert" }
    show(when: heard() >= 0) { p "sichtbar" }
    a = Gap("Feld")
    t = Gap("Feld 2")
  }
}

coding k1 {
  a: correct(number(a) == 1)
  t: codes(code(1, "eins", score: 1, when: accept(t, "x") or manual("Kriterium")), code(2, when: true))
}

booklet b1 "Heft" {
  allow({magnification})
  part("Teil") {
    instruction("Hinweis") { p "Text" }
    k1
  }
}`;

// One small item per entry whose bundle form differs from its declaration in prelude.af, with its expected form; all
// share one workspace, so their names differ
const TRANSLATED: Record<string, { source: string; check: (uses: Use[]) => void }> = {
    math: {
        source: `item u_math { p { math("x^2") } }`,
        check: uses => {
            const call = uses.find(u => 'op' in u && u.fn === 'math') as Extract<Expr, { op: 'call' }>;
            expect(call.args).toHaveLength(2);
            expect(call.args[0]).toMatchObject({ op: 'lit', value: expect.stringContaining('<math') });
            expect(call.args[1]).toEqual({ op: 'lit', value: 'x^2' });
        }
    },
    changed: meta('changed', 'changed(a)', ['a']),
    displayed: meta('displayed', 'displayed(a)', ['a']),
    sum_score: meta('sum_score', 'sum_score(a, b) > 0', ['a', 'b']),
    input: bound('input', `state s: Text = ""
              input(bind: s, label: "Feld")`),
    value: bound('value', `state s: Rational? = none
              value(bind: s, min: 0, max: 10, step: 1, label: "Wert")`)
};

function meta(fn: string, condition: string, vars: string[]) {
    return {
        source: `item u_${fn} { a = Gap("Feld") b = Gap("Feld 2") }
                 coding u_${fn} { a: correct(a == "x")  b: correct(b == "y")  r: correct(${condition}) }`,
        check: (uses: Use[]) => expect(uses.find(u => 'op' in u && u.fn === fn)).toEqual({ op: 'meta', fn, vars })
    };
}

function bound(element: string, body: string) {
    return {
        source: `component U_${element}() { ${body} }\nitem u_${element} { U_${element}() }`,
        check: (uses: Use[]) => {
            const node = uses.find(u => 'kind' in u && u.element === element) as ElementNode;
            expect(node.bind).toBe('s');
            expect(Object.keys(node.args)).not.toContain('bind');
        }
    };
}

let prelude: Map<string, Decl>;
let compiled: Record<string, Bundle>;
let resolvedUsed: Set<string>;

beforeAll(async () => {
    const sources: Record<string, string> = { everyEntry: EVERY_ENTRY, resolved: RESOLVED };
    for (const [name, sample] of Object.entries(TRANSLATED)) sources[`translated_${name}`] = sample.source;
    const { compile, services } = await workspace(sources);
    const documents = services.shared.workspace.LangiumDocuments;
    const document = documents.all.find(d => d.uri.path.endsWith('/prelude.af'));
    if (!document) throw new Error('prelude.af ist nicht geladen');
    prelude = builtinsOf(document.parseResult.value as ast.Document);
    compiled = {};
    for (const name of Object.keys(sources)) {
        const { bundle, errors } = compile(name);
        if (errors.length > 0) throw new Error(`${name}: ${errors.map(e => e.message).join('; ')}`);
        compiled[name] = bundle;
    }
    // Built-ins the sample for resolved names refers to (through the AST, since none of them reaches the bundle)
    const resolved = documents.getDocument(URI.parse('file:///extra/resolved.af'))!;
    resolvedUsed = new Set(AstUtils.streamAst(resolved.parseResult.value).filter(ast.isReference)
        .map(r => r.target.ref).filter(t => ast.isElementDecl(t) || (ast.isFunctionDecl(t) && t.builtin))
        .map(t => (t as Decl).name));
});

describe('Katalog und prelude.af', () => {
    test('jede eingebaute Funktion und jedes Element der Prelude steht im Katalog oder in RESOLVED_BUILTINS', () => {
        expect(coverageProblems(catalog, RESOLVED_BUILTINS, prelude)).toEqual([]);
    });

    test('ein fehlender, doppelter oder fremder Name fällt auf', () => {
        const copy: Catalog = structuredClone(catalog);
        copy.functions = copy.functions.filter(f => f.name !== 'heard');
        copy.elements.push({ name: 'gibt_es_nicht', parameters: [], children: false, description: 'Probe.' });
        copy.elements = copy.elements.filter(e => e.name !== 'dot');
        copy.functions.push({ name: 'dot', parameters: [], result: 'Int', description: 'Probe.' });
        const resolved = new Set([...RESOLVED_BUILTINS, 'point', 'auch_nicht']);
        expect(coverageProblems(copy, resolved, prelude)).toEqual([
            "'dot' ist in prelude.af als Element deklariert, im Katalog als Funktion.",
            "Funktion 'heard' aus prelude.af steht weder im Katalog noch in RESOLVED_BUILTINS.",
            "Funktion 'point' steht im Katalog und in RESOLVED_BUILTINS; entweder erreicht der Name das Bundle oder der Compiler löst ihn auf.",
            "Element 'gibt_es_nicht' steht im Katalog, prelude.af deklariert den Namen nicht als eingebaut.",
            "'auch_nicht' steht in RESOLVED_BUILTINS, prelude.af deklariert den Namen nicht als eingebaut."
        ]);
    });

    test('der Katalog weicht von prelude.af nur so ab, wie der Compiler übersetzt', () => {
        expect(translationProblems(catalog, prelude)).toEqual([]);
    });

    test('jede andere Abweichung von prelude.af fällt auf', () => {
        const copy: Catalog = structuredClone(catalog);
        const find = (name: string) => copy.functions.find(f => f.name === name)!;
        const element = (name: string) => copy.elements.find(e => e.name === name)!;
        find('math').parameters[0].type = 'Bool';
        delete find('sum_score').parameters[0].variadic;
        find('normalize').result = 'Content';
        find('image').parameters.reverse();
        element('input').parameters[0].type = 'Int';
        delete element('input').binding;
        element('value').parameters.shift();
        element('timer').events = [];
        copy.elements.reverse();
        expect(translationProblems(copy, prelude)).toEqual([
            "Funktion 'image', Parameter aus prelude.af: Katalog [\"width\",\"alt\",\"src\"], prelude.af [\"src\",\"alt\",\"width\"].",
            "Funktion 'math': Parameter 'mathml' gibt es in prelude.af nicht; ein vom Compiler vorbereiteter Wert ist Text, nicht Bool.",
            "Funktion 'normalize', result: Katalog \"Content\", prelude.af \"Text\".",
            "Funktion 'sum_score', parameters (Form meta: Namen der Antwortvariablen): Katalog [{\"name\":\"responses\",\"type\":\"Text\"}], prelude.af [{\"name\":\"responses\",\"type\":\"Text\",\"variadic\":true}].",
            expect.stringMatching(/^Element 'value', parameters \(ohne bind\): Katalog \[\{"name":"max"/),
            expect.stringMatching(/^Element 'input', parameters \(ohne bind\): Katalog \[\{"name":"label","type":"Int"\}/),
            "Element 'input', binding: Katalog nichts, prelude.af \"Text\".",
            "Element 'timer', events: Katalog [], prelude.af [\"elapsed\"].",
            expect.stringMatching(/^Reihenfolge \(elements\): Katalog polygon, caption, /)
        ]);
    });
});

describe('Katalog und Compiler', () => {
    test('der Compiler gibt genau die Funktionen mit form meta als meta aus', () => {
        expect([...META_FUNCTIONS].sort()).toEqual(catalog.functions.filter(f => f.form === 'meta').map(f => f.name).sort());
    });

    test('jeder erzeugte Aufruf und jedes erzeugte Element passt zu einem Katalogeintrag', () => {
        for (const [name, bundle] of Object.entries(compiled)) expect(useProblems(catalog, bundle), name).toEqual([]);
    });

    test('die Beispiele benutzen jeden Katalogeintrag', () => {
        const used = new Set(Object.values(compiled).flatMap(b => usesIn(b)).map(u => ('kind' in u ? u.element : u.fn)));
        expect([...catalog.functions, ...catalog.elements].map(e => e.name).filter(n => !used.has(n))).toEqual([]);
    });

    test('vom Compiler aufgelöste Namen erreichen das Bundle nie', () => {
        expect([...RESOLVED_BUILTINS].filter(n => !resolvedUsed.has(n))).toEqual([]);
        const names = new Set(usesIn(compiled.resolved).map(u => ('kind' in u ? u.element : u.fn)));
        expect([...names].filter(n => RESOLVED_BUILTINS.has(n))).toEqual([]);
    });

    test('zu jedem Eintrag, dessen Bundle-Form von prelude.af abweicht, gibt es ein Beispiel', () => {
        const differing = [...catalog.functions, ...catalog.elements].filter(e => bundleFormDiffers(e, prelude.get(e.name)!)).map(e => e.name);
        expect(Object.keys(TRANSLATED).sort()).toEqual(differing.sort());
    });

    test.each(Object.keys(TRANSLATED))('%s steht im Bundle in der Form des Katalogs', name => {
        TRANSLATED[name].check(usesIn(compiled[`translated_${name}`]));
    });

    test('ein Aufruf oder Element, das nicht zum Katalog passt, fällt auf', () => {
        const bundle: Bundle = structuredClone(compiled.everyEntry);
        const uses = usesIn(bundle);
        const element = (name: string) => uses.find(u => 'kind' in u && u.element === name) as ElementNode;
        const call = (fn: string) => uses.find(u => 'op' in u && u.fn === fn) as Extract<Expr, { op: 'call' }>;
        call('math').args.pop();
        const input = element('input');
        input.args = Object.fromEntries(Object.entries(input.args).reverse());
        delete element('value').bind;
        element('p').bind = 's';
        element('timer').on = { expired: [] };
        element('flow').children = [{ kind: 'content', value: { op: 'lit', value: 'x' } }];
        const page = bundle.items.find(i => i.name === 'alles')!.body[0] as ElementNode;
        page.children.push(
            { kind: 'element', element: 'show', args: {}, children: [] },
            { kind: 'content', value: { op: 'call', fn: 'correct', args: [] } },
            { kind: 'content', value: { op: 'call', fn: 'sum_score', args: [] } }
        );
        const problems = useProblems(catalog, bundle);
        expect(problems).toEqual(expect.arrayContaining([
            "Element 'show' steht im Bundle, der Katalog kennt es nicht.",
            "Funktion 'correct' steht im Bundle (call), der Katalog kennt sie nicht.",
            "Funktion 'sum_score': im Bundle als call, laut Katalog als meta.",
            "Funktion 'math' (call): im Bundle 1 Argument(e), laut Katalog mathml, tex.",
            "Element 'input': Argumente im Bundle keys, at, multiline, max, width, kind, label, laut Katalog label, kind, width, max, multiline, at, keys.",
            "Element 'value' bindet laut Katalog einen Zustand (T?), im Bundle fehlt bind.",
            "Element 'p' bindet im Bundle den Zustand 's', laut Katalog bindet es nichts.",
            "Element 'timer': Ereignis 'expired' im Bundle, laut Katalog elapsed.",
            "Element 'flow' hat im Bundle Inhalt, laut Katalog nimmt es keinen."
        ]));
        expect(problems).toHaveLength(9);
    });
});
