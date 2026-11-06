import { DefaultLinker, type AstNodeDescription, type LinkingError, type ReferenceInfo } from 'langium';
import { isReference } from './generated/ast.js';
import type { ItemServices } from './item-module.js';

/** German noun for each reference target type, used in linking error messages. */
const KIND: Readonly<Record<string, string>> = {
    NamedElement: 'Name',
    Parameter: 'Parameter',
    EventDecl: 'Ereignis',
    StateDecl: 'Zustand',
    Writable: 'Zustand',
    Binding: 'Antwort',
    Item: 'Aufgabe'
};

/** Linker with German messages for unresolved references; lists the allowed members when an enum value is expected. */
export class ItemLinker extends DefaultLinker {
    constructor(protected readonly services: ItemServices) {
        super(services);
    }

    protected override createLinkingError(refInfo: ReferenceInfo, targetDescription?: AstNodeDescription): LinkingError {
        const error = super.createLinkingError(refInfo, targetDescription);
        const name = refInfo.reference.$refText;
        const container = refInfo.container;
        const expected = isReference(container) ? this.services.types.TypeSystem.expectedEnum(container) : undefined;
        if (expected) {
            return { ...error, message: `'${name}' gibt es bei ${expected.name} nicht. Erlaubt: ${expected.members.map(m => m.name).join(', ')}.` };
        }
        const kind = KIND[this.reflection.getReferenceType(refInfo)] ?? 'Name';
        return { ...error, message: `${kind} '${name}' ist hier nicht bekannt.` };
    }
}
