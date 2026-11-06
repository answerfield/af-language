import { DefaultWorkspaceManager, URI, type FileSystemNode, type LangiumDocument, type LangiumSharedCoreServices, type WorkspaceFolder } from 'langium';
import { PRELUDE } from './prelude.generated.js';

export { PRELUDE };

/** URI scheme of the built-in libraries (prelude, std). */
export const BUILTIN_SCHEME = 'af-builtin';

/** True if the URI points to a built-in library document. */
export function isBuiltinUri(uri: URI): boolean {
    return uri.scheme === BUILTIN_SCHEME;
}

/**
 * True for the sources of the built-in libraries in a checkout of AF or an installed package (language/src/builtin/prelude.af,
 * stdlib/std.af). They are loaded as built-ins already; loaded again as workspace files they would shadow them.
 */
export function isLibrarySource(path: string): boolean {
    return /(^|[\\/])(language[\\/]src[\\/]builtin[\\/]prelude|stdlib[\\/]std)\.af$/.test(path);
}

let stdlib: Promise<string> | undefined;

/**
 * Text of std.af from the package `@answerfield/stdlib` (a dependency of this package, released with it). Loaded once;
 * bundlers (esbuild) take the package in through the import.
 */
export function loadStdlib(): Promise<string> {
    stdlib ??= import('@answerfield/stdlib').then(module => module.STD);
    return stdlib;
}

/** URIs and sources of all built-in libraries: the embedded prelude and std.af from `@answerfield/stdlib`. */
export async function builtinSources(): Promise<ReadonlyArray<{ uri: URI; text: string }>> {
    const libraries: Array<[string, string]> = [['prelude.af', PRELUDE], ['std.af', await loadStdlib()]];
    return libraries.map(([file, text]) => ({ uri: URI.parse(`${BUILTIN_SCHEME}:///${file}`), text }));
}

/** Creates (but does not register or build) a document for each built-in library. */
export async function createBuiltinDocuments(shared: LangiumSharedCoreServices): Promise<LangiumDocument[]> {
    const factory = shared.workspace.LangiumDocumentFactory;
    return (await builtinSources()).map(({ uri, text }) => factory.fromString(text, uri));
}

/**
 * Adds the built-in libraries to the document store and builds them.
 * For tests and tools that run without a language server.
 */
export async function loadBuiltinDocuments(shared: LangiumSharedCoreServices): Promise<LangiumDocument[]> {
    const documents = shared.workspace.LangiumDocuments;
    const loaded = (await createBuiltinDocuments(shared)).filter(d => !documents.hasDocument(d.uri));
    loaded.forEach(d => documents.addDocument(d));
    await shared.workspace.DocumentBuilder.build(loaded, { validation: true });
    return loaded;
}

/** Workspace manager that adds the built-in libraries to every workspace. */
export class ItemWorkspaceManager extends DefaultWorkspaceManager {
    protected readonly shared: LangiumSharedCoreServices;

    constructor(services: LangiumSharedCoreServices) {
        super(services);
        this.shared = services;
    }

    protected override async loadAdditionalDocuments(_folders: WorkspaceFolder[], collector: (document: LangiumDocument) => void): Promise<void> {
        (await createBuiltinDocuments(this.shared)).forEach(collector);
    }

    override shouldIncludeEntry(entry: FileSystemNode): boolean {
        return super.shouldIncludeEntry(entry) && !(entry.isFile && isLibrarySource(entry.uri.path));
    }
}
