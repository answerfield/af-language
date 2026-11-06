import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import { createItemServices, loadBuiltinDocuments } from '@answerfield/language';
import { compileDocument, type CompileOptions } from './index.js';

/**
 * All example files below `dir`; `withImports: false` leaves out folders named `*-import` (generated items that no
 * test refers to by name) so that per-test workspaces stay fast.
 */
export function exampleFiles(dir: string, withImports = true): string[] {
    return readdirSync(dir).flatMap(f => {
        const path = join(dir, f);
        if (statSync(path).isDirectory()) return !withImports && f.endsWith('-import') ? [] : exampleFiles(path, withImports);
        return f.endsWith('.af') ? [path] : [];
    });
}

/** JSON text with sorted object keys, two-space indentation and a final newline (JSON objects carry no order). */
export function stableJson(value: unknown): string {
    const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
        : v !== null && typeof v === 'object'
            ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]))
            : v;
    return JSON.stringify(sort(value), null, 2) + '\n';
}

/**
 * Compiles the conformance themes in `dir` (the `cases/` folder of @answerfield/conformance) the way their bundles
 * are written: every `.af` file of `dir` (shared sources such as `probes.af` included) in one workspace with
 * validation, each theme with `compileDocument` and no dev fields. Returns theme → bundle as {@link stableJson} text.
 * Throws with all errors if a source does not validate or a theme does not compile.
 */
export async function compileConformance(dir: string, themes: readonly string[]): Promise<Record<string, string>> {
    const files = readdirSync(dir).filter(f => f.endsWith('.af')).sort();
    const { shared, Item } = createItemServices(EmptyFileSystem);
    await loadBuiltinDocuments(shared);
    const factory = shared.workspace.LangiumDocumentFactory;
    const documents = files.map(f => factory.fromString(readFileSync(join(dir, f), 'utf8'), URI.file(join(dir, f))));
    documents.forEach(d => shared.workspace.LangiumDocuments.addDocument(d));
    await shared.workspace.DocumentBuilder.build(documents, { validation: true });

    const problems = documents.flatMap((d, i) => (d.diagnostics ?? []).filter(x => x.severity === 1)
        .map(x => `${files[i]}:${x.range.start.line + 1}: ${x.message}`));
    const bundles: Record<string, string> = {};
    for (const theme of themes) {
        const index = files.indexOf(`${theme}.af`);
        if (index < 0) {
            problems.push(`${theme}.af fehlt in ${dir}`);
            continue;
        }
        if (problems.length > 0) continue;
        const result = compileDocument(Item, documents[index]);
        problems.push(...result.errors.map(e => `${theme}.af: ${e.message}`));
        bundles[theme] = stableJson(result.bundle);
    }
    if (problems.length > 0) throw new Error(problems.join('\n'));
    return bundles;
}

/** Loads all files below `root` plus the inline sources in `extra` into one workspace; returns a function that compiles a file or source text. */
export async function workspace(extra: Record<string, string>, root: string) {
    const { shared, Item } = createItemServices(EmptyFileSystem);
    await loadBuiltinDocuments(shared);
    const factory = shared.workspace.LangiumDocumentFactory;
    const documents = new Map<string, LangiumDocument>();
    for (const file of exampleFiles(root, false)) {
        documents.set(file, factory.fromString(readFileSync(file, 'utf8'), URI.file(file)));
    }
    for (const [name, text] of Object.entries(extra)) {
        documents.set(name, factory.fromString(text, URI.parse(`file:///extra/${name}.af`)));
    }
    documents.forEach(d => shared.workspace.LangiumDocuments.addDocument(d));
    await shared.workspace.DocumentBuilder.build([...documents.values()], { validation: true });
    return {
        services: Item,
        compile: (key: string, options: CompileOptions = {}) => {
            const file = [...documents.keys()].find(k => k === key || k.endsWith(key));
            if (!file) throw new Error(`Unbekannt: ${key}`);
            return compileDocument(Item, documents.get(file)!, options);
        }
    };
}
