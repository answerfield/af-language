import { createRequire } from 'node:module';
import { beforeAll, describe, expect, test } from 'vitest';
import type { Diagnostic } from 'vscode-languageserver-types';
import type { Catalog } from '@answerfield/bundle';
import { GENERIC_TYPES, PRIMITIVE_TYPES } from '../src/type-system.js';
import { isEnumDecl, type Document } from '../src/generated/ast.js';
import { errors, format, setup } from './helpers.js';

// The contract between language and runtime: the enums of `prelude.af` and the base types of the type system are
// exactly those of the catalog. Functions and elements differ between author form and bundle form; the compiler's
// tests check them (packages/compiler/test/catalog.test.ts).
const catalog: Catalog = createRequire(import.meta.url)('@answerfield/bundle/catalog.json');

let prelude: Document;
let diagnosticsOf: (source: string) => Promise<Diagnostic[]>;

beforeAll(async () => {
    const env = await setup();
    const document = env.builtins.find(d => d.uri.path.endsWith('/prelude.af'));
    if (!document) throw new Error('prelude.af ist nicht eingebettet');
    prelude = document.parseResult.value as Document;
    diagnosticsOf = env.diagnosticsOf;
});

/** The enums of `prelude.af` in the shape of the catalog, without `description`. */
const enumsOf = (document: Document) => document.elements.filter(isEnumDecl).map(e => ({ name: e.name, values: e.members.map(m => m.name) }));

const show = (v: unknown) => (v === undefined ? 'nichts' : JSON.stringify(v));

/** Every difference between `prelude.af` and the type system on one side and the catalog on the other, one message each. */
function differences(k: Catalog, document: Document): string[] {
    const found: string[] = [];
    const inPrelude = new Map(enumsOf(document).map(d => [d.name, d.values]));
    const inCatalog = new Map(k.enums.map(d => [d.name, d.values]));
    for (const name of inPrelude.keys()) if (!inCatalog.has(name)) found.push(`Aufzählung '${name}' steht in prelude.af, fehlt im Katalog.`);
    for (const name of inCatalog.keys()) if (!inPrelude.has(name)) found.push(`Aufzählung '${name}' steht im Katalog, fehlt in prelude.af.`);
    for (const [name, values] of inPrelude) {
        if (inCatalog.has(name) && show(inCatalog.get(name)) !== show(values)) {
            found.push(`Aufzählung '${name}', values: Katalog ${show(inCatalog.get(name))}, prelude.af ${show(values)}.`);
        }
    }
    const order = (names: Iterable<string>, other: Map<string, unknown>) => [...names].filter(n => other.has(n));
    const preludeOrder = order(inPrelude.keys(), inCatalog), catalogOrder = order(inCatalog.keys(), inPrelude);
    if (preludeOrder.join() !== catalogOrder.join()) {
        found.push(`Reihenfolge der Aufzählungen: Katalog ${catalogOrder.join(', ')}; prelude.af ${preludeOrder.join(', ')}.`);
    }
    // Base types of the type system
    const types = new Map<string, string[] | undefined>([
        ...PRIMITIVE_TYPES.map(n => [n, undefined] as [string, undefined]),
        ...Object.entries(GENERIC_TYPES).map(([n, t]) => [n, [...t]] as [string, string[]])
    ]);
    const listed = new Map(k.baseTypes.map(g => [g.name, g.typeParameters]));
    for (const name of types.keys()) if (!listed.has(name)) found.push(`Grundtyp '${name}' steht im Typsystem, fehlt im Katalog.`);
    for (const name of listed.keys()) if (!types.has(name)) found.push(`Grundtyp '${name}' steht im Katalog, fehlt im Typsystem.`);
    for (const [name, params] of types) {
        if (listed.has(name) && show(listed.get(name)) !== show(params)) {
            found.push(`Grundtyp '${name}', typeParameters: Katalog ${show(listed.get(name))}, Typsystem ${show(params)}.`);
        }
    }
    return found;
}

describe('Katalog: Aufzählungen und Grundtypen', () => {
    test('die Aufzählungen von prelude.af und die Grundtypen des Typsystems entsprechen genau dem Katalog', () => {
        expect(differences(catalog, prelude)).toEqual([]);
    });

    test('jeder Grundtyp des Katalogs ist im Typsystem bekannt, ein fremder Name nicht', async () => {
        const typeOf = (g: Catalog['baseTypes'][number]) => g.typeParameters ? `${g.name}<${g.typeParameters.map(() => 'Int').join(', ')}>` : g.name;
        const source = `fn probe(${catalog.baseTypes.map((g, i) => `p${i}: ${typeOf(g)}`).join(', ')}): Bool = true`;
        expect(format(errors(await diagnosticsOf(source)))).toBe('');
        expect(format(errors(await diagnosticsOf('fn probe(x: NoSuchType): Bool = true')))).toMatch(/Unbekannter Typ 'NoSuchType'/);
    });

    test('fehlt ein Eintrag im Katalog, nennt der Vergleich ihn', () => {
        const copy: Catalog = {
            ...catalog,
            enums: catalog.enums.filter(a => a.name !== 'Tone'),
            baseTypes: catalog.baseTypes.filter(g => g.name !== 'Duration')
        };
        expect(differences(copy, prelude)).toEqual([
            "Aufzählung 'Tone' steht in prelude.af, fehlt im Katalog.",
            "Grundtyp 'Duration' steht im Typsystem, fehlt im Katalog."
        ]);
    });

    test('steht ein Eintrag zu viel im Katalog oder weicht er ab, nennt der Vergleich jeden Unterschied einzeln', () => {
        const copy: Catalog = structuredClone(catalog);
        copy.enums.push({ name: 'Extra', values: ['a'], description: 'Zusätzliche Aufzählung.' });
        copy.enums.find(a => a.name === 'Spaces')!.values.reverse();
        copy.baseTypes.push({ name: 'Extra', description: 'Zusätzlicher Typ.' });
        copy.baseTypes.find(g => g.name === 'Interval')!.typeParameters = ['T', 'U'];
        expect(differences(copy, prelude)).toEqual([
            "Aufzählung 'Extra' steht im Katalog, fehlt in prelude.af.",
            expect.stringMatching(/^Aufzählung 'Spaces', values: Katalog \[.+\], prelude\.af \[.+\]\.$/),
            "Grundtyp 'Extra' steht im Katalog, fehlt im Typsystem.",
            'Grundtyp \'Interval\', typeParameters: Katalog ["T","U"], Typsystem ["T"].'
        ]);
    });

    test('eine andere Reihenfolge als in prelude.af fällt auf', () => {
        const copy: Catalog = { ...catalog, enums: [...catalog.enums].reverse() };
        expect(differences(copy, prelude)).toEqual([expect.stringMatching(/^Reihenfolge der Aufzählungen: Katalog Markup, /)]);
    });
});
