import { EmptyFileSystem, URI, type LangiumDocument } from 'langium';
import type { Diagnostic } from 'vscode-languageserver-types';
import { createItemServices, loadBuiltinDocuments } from '../src/index.js';
import type { Document } from '../src/generated/ast.js';

let counter = 0;

/** Creates services with the built-in libraries loaded, plus helpers to validate source text. */
export async function setup() {
    const services = createItemServices(EmptyFileSystem);
    const builtins = await loadBuiltinDocuments(services.shared);

    /** Parses and validates one or more sources together (they stay in the workspace); `{ path, text }` sets the file path. */
    async function validate(...sources: Array<string | { path: string; text: string }>): Promise<Array<{ document: LangiumDocument<Document>; diagnostics: Diagnostic[] }>> {
        const factory = services.shared.workspace.LangiumDocumentFactory;
        const documents = sources.map(s => typeof s === 'string'
            ? factory.fromString<Document>(s, URI.parse(`file:///test/${++counter}.af`))
            : factory.fromString<Document>(s.text, URI.parse(`file:///${s.path}`)));
        documents.forEach(d => services.shared.workspace.LangiumDocuments.addDocument(d));
        await services.shared.workspace.DocumentBuilder.build(documents, { validation: true });
        return documents.map(document => ({ document, diagnostics: document.diagnostics ?? [] }));
    }

    /** Validates a single source and removes it from the workspace afterwards. */
    async function diagnosticsOf(source: string): Promise<Diagnostic[]> {
        const [result] = await validate(source);
        await services.shared.workspace.DocumentBuilder.update([], [result.document.uri]);
        return result.diagnostics;
    }

    return { services, builtins, validate, diagnosticsOf };
}

/** Formats diagnostics as `line:col [severity] message`, one per line. */
export function format(diagnostics: Diagnostic[]): string {
    return diagnostics.map(d => `${d.range.start.line + 1}:${d.range.start.character + 1} [${severity(d.severity)}] ${d.message}`).join('\n');
}

/** Only the error-severity diagnostics. */
export function errors(diagnostics: Diagnostic[]): Diagnostic[] {
    return diagnostics.filter(d => d.severity === 1);
}

function severity(s: number | undefined): string {
    return ['?', 'error', 'warning', 'info', 'hint'][s ?? 0];
}
