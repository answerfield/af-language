// Golden test of the compiler: compiles each conformance theme of @answerfield/conformance (the `.af` sources) and
// requires the result to equal test/conformance/<theme>.bundle.json, the goldens kept with the compiler. The bundles
// in the conformance package are frozen vectors of the format version and are not compared here, so a change of the
// compiler output only needs new goldens: UPDATE_GOLDEN=1 npx vitest run test/conformance.test.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { BUNDLE_VERSION } from '@answerfield/bundle';
import { THEMES } from '@answerfield/conformance';
import { compileConformance } from '../src/testing.js';

const require = createRequire(import.meta.url);
const CASES = dirname(require.resolve('@answerfield/conformance/cases/probes.af'));
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'conformance');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const HOW_TO_UPDATE = 'UPDATE_GOLDEN=1 npx vitest run test/conformance.test.ts (in packages/compiler)';

const goldenPath = (theme: string) => join(GOLDEN, `${theme}.bundle.json`);
const show = (v: unknown) => (v === undefined ? 'fehlt' : JSON.stringify(v));

/** Path and values of the first difference between two JSON values (objects by sorted key), undefined if equal. */
function firstDifference(a: unknown, b: unknown, path = ''): string | undefined {
    if (Array.isArray(a) && Array.isArray(b)) {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const d = firstDifference(a[i], b[i], `${path}[${i}]`);
            if (d) return d;
        }
        return undefined;
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
        const x = a as Record<string, unknown>;
        const y = b as Record<string, unknown>;
        for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
            const d = firstDifference(x[k], y[k], `${path}.${k}`);
            if (d) return d;
        }
        return undefined;
    }
    return Object.is(a, b) ? undefined : `${path || '(Wurzel)'}: erzeugt ${show(a)}, Golden ${show(b)}`;
}

/** Empty if the golden text equals the compiled one, otherwise a message with theme, path and the way to update. */
function compare(theme: string, compiled: string, golden: string | undefined): string {
    if (compiled === golden) return '';
    const where = `packages/compiler/test/conformance/${theme}.bundle.json`;
    const d = golden === undefined ? `${where} fehlt` : firstDifference(JSON.parse(compiled), JSON.parse(golden));
    const what = golden === undefined ? d : d === undefined ? `${where} ist anders formatiert` : `${where}, erster Unterschied bei ${d}`;
    return `Thema ${theme}: ${what}. Goldens neu schreiben: ${HOW_TO_UPDATE}`;
}

function readGolden(theme: string): string | undefined {
    try {
        return readFileSync(goldenPath(theme), 'utf8');
    } catch {
        return undefined;
    }
}

let compiled: Record<string, string>;
beforeAll(async () => { compiled = await compileConformance(CASES, THEMES); }, 60_000);

describe('Konformitätsfälle als Goldens des Compilers', () => {
    test.each([...THEMES])('Kompilierung von %s entspricht dem Golden', theme => {
        if (UPDATE) {
            mkdirSync(GOLDEN, { recursive: true });
            writeFileSync(goldenPath(theme), compiled[theme]);
        }
        expect(compare(theme, compiled[theme], readGolden(theme))).toBe('');
    });

    test('ein veraltetes Golden wird mit Thema, Pfad und Aktualisierungsweg gemeldet', () => {
        const stale = JSON.parse(compiled.standard);
        // Change one known scalar; everything else stays equal to the compiled bundle.
        stale.version = 'x' + stale.version;
        const message = compare('standard', compiled.standard, JSON.stringify(stale));
        expect(message).toMatch(/^Thema standard: packages\/compiler\/test\/conformance\/standard\.bundle\.json, erster Unterschied bei \.version: /);
        expect(message).toContain('UPDATE_GOLDEN=1');
    });

    // The vectors of the conformance package belong to one format version; a new BUNDLE_VERSION needs new vectors
    // (node scripts/konformitaet.intern.mjs in the monorepo) and a release of the format.
    test.each([...THEMES])('Formatvektor %s trägt BUNDLE_VERSION', theme => {
        const vector = JSON.parse(readFileSync(join(CASES, `${theme}.bundle.json`), 'utf8'));
        expect(vector.version, `cases/${theme}.bundle.json in @answerfield/conformance`).toBe(BUNDLE_VERSION);
    });
});
