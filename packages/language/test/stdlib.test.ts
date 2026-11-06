import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { loadStdlib } from '../src/builtin/builtins.js';
import { format, setup } from './helpers.js';

// std.af of the package @answerfield/stdlib (a dependency of this package), as installed.
const std = readFileSync(createRequire(import.meta.url).resolve('@answerfield/stdlib/std.af'), 'utf8');

describe('Standardbibliothek', () => {
    test('wird aus dem Paket @answerfield/stdlib geladen', async () => {
        expect(await loadStdlib()).toBe(std);
    });

    test('std.af ist eingebaut, fehlerfrei und formatiert', async () => {
        const { builtins, services } = await setup();
        const document = builtins.find(d => d.uri.toString() === 'af-builtin:/std.af');
        if (!document) throw new Error('std.af ist nicht unter den eingebauten Bibliotheken');
        expect(document.textDocument.getText()).toBe(std);
        expect(format(document.diagnostics ?? [])).toBe('');
        const edits = await services.Item.lsp.Formatter!.formatDocument(document, {
            textDocument: { uri: document.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        expect(TextDocument.applyEdits(document.textDocument, edits)).toBe(std);
    });
});
