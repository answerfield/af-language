import { AstUtils } from 'langium';
import { isCoding, isListLiteral, isStringLiteral, type Binding, type Coding, type CodingRule, type Document, type Item } from '../generated/ast.js';
import { matchArguments, printType } from '../type-system.js';
import type { ItemServices } from '../item-module.js';
import { callOf } from './edits.js';

/** Codings of an item anywhere in the workspace, those of the item's own document first. */
export function codingsOf(services: ItemServices, item: Item): Coding[] {
    const own = AstUtils.getDocument(item);
    return services.shared.workspace.LangiumDocuments.all
        .flatMap(d => (d.parseResult.value as Document).elements.filter(isCoding))
        .filter(c => c.item.ref === item)
        .toArray()
        .sort((a, b) => Number(AstUtils.getDocument(b) === own) - Number(AstUtils.getDocument(a) === own));
}

/** The coding rule for a response, if any. */
export function ruleOf(services: ItemServices, item: Item, name: string): CodingRule | undefined {
    for (const coding of codingsOf(services, item)) {
        const rule = coding.rules.find(r => r.name === name);
        if (rule) return rule;
    }
    return undefined;
}

/** Typical coding rules for a response, by its component and type (e.g. one per option of a Choice). */
export function codingSuggestions(services: ItemServices, binding: Binding): Array<{ value: string; label?: string }> {
    const name = binding.name;
    const type = printType(services.types.TypeSystem.typeOfDeclaration(binding)).replace(/\?$/, '');
    const call = callOf(binding);
    const manual = { value: `correct(manual("Kriterium"))`, label: 'Kodierende beurteilen' };
    if (type === 'Set<Int>' || type === 'Int' && call?.target.$refText === 'Select') {
        // one suggestion per option, labelled with its text
        const options = call ? matchArguments(call)?.matches.find(m => m.parameter.name === 'options')?.argument.value : undefined;
        const texts = options && isListLiteral(options) ? options.elements.map(e => isStringLiteral(e) ? e.value : e.$cstNode?.text ?? '') : [];
        const set = type === 'Set<Int>';
        return [
            ...texts.map((t, i) => ({ value: `correct(${name} == ${set ? `{${i + 1}}` : i + 1})`, label: `richtig: ${t}` })),
            ...(texts.length === 0 ? [{ value: `correct(${name} == ${set ? '{1}' : '1'})` }] : []),
            manual
        ];
    }
    switch (type) {
        case 'Text': return [
            { value: `correct(normalize(${name}) in {"Antwort"})`, label: 'eine von mehreren Schreibweisen' },
            { value: `correct(number(${name}) == 0)`, label: 'Zahl, auch als Bruch oder Dezimalzahl' },
            manual
        ];
        case 'Int': case 'Rational': return [
            { value: `correct(${name} == 0)` }, { value: `correct(${name} in 0 .. 1)`, label: 'Bereich' }, manual
        ];
        case 'Bool': return [{ value: `correct(${name} == true)` }, manual];
        case 'Point': return [{ value: `correct(distance(${name}, (0 | 0)) <= 0.5)`, label: 'Punkt mit Toleranz' }, manual];
        case 'Set<List<Point?>>': return [
            { value: `correct(shape(${name}) == shape({[(0 | 0), (1 | 0)]}))`, label: 'gezeichnete Figur, Lage egal' }, manual
        ];
        default: return [manual];
    }
}
