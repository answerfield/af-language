import { inject, type Module, type LangiumSharedCoreServices } from 'langium';
import {
    createDefaultModule, createDefaultSharedModule, type DefaultSharedModuleContext, type LangiumServices,
    type LangiumSharedServices, type PartialLangiumServices, type PartialLangiumSharedServices
} from 'langium/lsp';
import { AfLanguageGeneratedModule, AfLanguageGeneratedSharedModule } from './generated/module.js';
import { ItemValidator, registerValidationChecks } from './item-validator.js';
import { ItemScopeComputation, ItemScopeProvider } from './item-scope.js';
import { ItemLinker } from './item-linker.js';
import { TypeSystem } from './type-system.js';
import { ItemHoverProvider } from './lsp/item-hover.js';
import { ItemFormatter } from './lsp/item-formatter.js';
import { ItemSemanticTokenProvider } from './lsp/item-semantic-tokens.js';
import { ItemCodeActionProvider } from './lsp/item-code-actions.js';
import { ItemDocumentSymbolProvider } from './lsp/item-symbols.js';
import { ItemWorkspaceManager } from './builtin/builtins.js';
import { ItemValueConverter } from './item-value-converter.js';

/** Services the AF language adds on top of Langium's defaults. */
export type ItemAddedServices = {
    validation: {
        ItemValidator: ItemValidator
    },
    types: {
        TypeSystem: TypeSystem
    }
};

/** All services of the AF language. */
export type ItemServices = LangiumServices & ItemAddedServices;

/** Dependency-injection module binding the AF-specific service implementations. */
export const ItemModule: Module<ItemServices, PartialLangiumServices & ItemAddedServices> = {
    parser: {
        ValueConverter: () => new ItemValueConverter()
    },
    references: {
        ScopeComputation: services => new ItemScopeComputation(services),
        ScopeProvider: services => new ItemScopeProvider(services),
        Linker: services => new ItemLinker(services)
    },
    validation: {
        ItemValidator: services => new ItemValidator(services)
    },
    types: {
        TypeSystem: services => new TypeSystem(services)
    },
    lsp: {
        HoverProvider: services => new ItemHoverProvider(services),
        Formatter: () => new ItemFormatter(),
        SemanticTokenProvider: services => new ItemSemanticTokenProvider(services),
        CodeActionProvider: () => new ItemCodeActionProvider(),
        DocumentSymbolProvider: () => new ItemDocumentSymbolProvider()
    }
};

/** Shared module that loads the built-in libraries into the workspace. */
export const ItemSharedModule: Module<LangiumSharedServices, PartialLangiumSharedServices> = {
    workspace: {
        WorkspaceManager: services => new ItemWorkspaceManager(services as LangiumSharedCoreServices)
    }
};

/** Creates the shared and language services and registers the validation checks. */
export function createItemServices(context: DefaultSharedModuleContext): { shared: LangiumSharedServices; Item: ItemServices } {
    const shared = inject(createDefaultSharedModule(context), AfLanguageGeneratedSharedModule, ItemSharedModule);
    const Item = inject(createDefaultModule({ shared }), AfLanguageGeneratedModule, ItemModule);
    shared.ServiceRegistry.register(Item);
    registerValidationChecks(Item);
    if (!context.connection) {
        // Without a language server no client sends a configuration request, so mark the provider as initialized.
        shared.workspace.ConfigurationProvider.initialized({});
    }
    return { shared, Item };
}
