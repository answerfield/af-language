import { describe, expect, test } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { format, setup } from './helpers.js';

describe('Prelude', () => {
    test('ist eingebettet, fehlerfrei und formatiert', async () => {
        const { builtins, services } = await setup();
        const prelude = builtins.find(d => d.uri.toString() === 'af-builtin:/prelude.af');
        if (!prelude) throw new Error('prelude.af ist nicht eingebettet');
        expect(format(prelude.diagnostics ?? [])).toBe('');
        const edits = await services.Item.lsp.Formatter!.formatDocument(prelude, {
            textDocument: { uri: prelude.uri.toString() },
            options: { tabSize: 2, insertSpaces: true }
        });
        expect(TextDocument.applyEdits(prelude.textDocument, edits)).toBe(prelude.textDocument.getText());
    });
});
