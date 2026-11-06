/**
 * Contract between the visual editor and the language services.
 * Nodes are addressed by their ID (AST path); the editor never depends on the language.
 */

/** Edit requested by the visual editor; the language service turns it into a source change. */
export type EditIntent =
    /** Set an argument; `value` is expression source, e.g. `12`, `"Text"`, `radio`. */
    | { kind: 'setArgument'; node: string; param: string; value: string }
    | { kind: 'removeArgument'; node: string; param: string }
    | { kind: 'delete'; node: string }
    /** Insert a statement (source text) at position `index` in the body of `parent`. */
    | { kind: 'insert'; parent: string; index: number; text: string }
    | { kind: 'move'; node: string; parent: string; index: number }
    /** Insert a new palette entry before, after or inside `target`; the language picks template and response name. */
    | { kind: 'create'; callable: string; target: string; position: DropPosition }
    /** Move a statement before, after or inside `target`. */
    | { kind: 'moveTo'; node: string; target: string; position: DropPosition }
    /** Insert a copy right after; responses in the copy get new names. */
    | { kind: 'duplicate'; node: string }
    /** Set a `point(x, y)` argument (for lists, element `index`, 0-based); `x`, `y` are source text. */
    | { kind: 'setPoint'; node: string; param: string; index?: number; x: string; y: string }
    /** Set list element `index` (0-based); `value` is source text. */
    | { kind: 'setListItem'; node: string; param: string; index: number; value: string }
    /** Table: append a cell to every row. */
    | { kind: 'addColumn'; node: string }
    /** Append a new item (with coding) or component to the document, named after the file. */
    | { kind: 'scaffold'; what: 'item' | 'component' }
    /** Turn a statement of an item into a new component; what it uses from the item becomes parameters. */
    | { kind: 'extract'; node: string };

/** Position relative to a node when inserting or moving. */
export type DropPosition = 'before' | 'after' | 'inside';

/** Palette entry: an element or component that can be inserted into an item. */
export interface PaletteEntry {
    name: string;
    group: string;
    doc?: string;
    /** Component with a response: inserted as `name = …`. */
    response: boolean;
    /** Accepts content. */
    container: boolean;
    /** From the author's own workspace (not prelude/std). */
    own: boolean;
}

/** Draggable point of a node (`point(x, y)` as an argument or in a list of points). */
export interface PointHandle {
    param: string;
    index?: number;
    x: number;
    y: number;
    label?: string;
}

/** Current value of a parameter, in the form an editor form can show it. */
export type ValueDescription =
    | { kind: 'text'; value: string }
    | { kind: 'number'; text: string }
    | { kind: 'bool'; value: boolean }
    | { kind: 'enum'; value: string }
    | { kind: 'size'; text: string }
    | { kind: 'list'; items: Array<{ kind: 'text' | 'number' | 'expression'; value: string }> }
    | { kind: 'interval'; from: string; to: string }
    /** Expression that can only be edited as text. */
    | { kind: 'expression'; text: string };

/** Parameter of a node as shown in the property form. */
export interface ParamDescription {
    name: string;
    /** Display name, e.g. for pseudo-parameters. */
    label: string;
    type: string;
    required: boolean;
    /** Default value as source text. */
    default?: string;
    enumValues?: string[];
    doc?: string;
    /** Absent if the argument is not given. */
    value?: ValueDescription;
    /** Positional argument (name not written in the source). */
    positional?: boolean;
    /** Typical values offered while editing (e.g. coding rules); `label` explains one. */
    suggestions?: Array<{ value: string; label?: string }>;
    /** Source text of a new list entry (default: a text). */
    newItem?: string;
}

/** Node as shown in the visual editor (tree and property form). */
export interface NodeDescription {
    id: string;
    /** E.g. "Choice", "p", "show when", "Text". */
    label: string;
    kind: 'item' | 'component' | 'element' | 'atom' | 'function' | 'content' | 'show' | 'for' | 'other';
    binding?: string;
    doc?: string;
    params: ParamDescription[];
    /** Can hold children. */
    container: boolean;
    /** Can be deleted or moved. */
    removable: boolean;
    /** Points that can be dragged on the canvas. */
    points?: PointHandle[];
    /** Further actions offered for this node. */
    actions?: Array<'duplicate' | 'addColumn' | 'extract'>;
}

/** Diagnostic with offsets in the main document. */
export interface DiagnosticInfo {
    severity: 'error' | 'warning';
    message: string;
    start: number;
    end: number;
}

/** Result of applying an {@link EditIntent}; `error` explains a refusal. */
export interface EditOutcome {
    ok: boolean;
    error?: string;
}
