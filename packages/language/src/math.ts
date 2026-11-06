import temml from 'temml';

/**
 * Converts a LaTeX formula to MathML (via Temml). Runs at compile time; the runtime only inserts the finished
 * MathML, which current browsers render and screen readers announce natively. Throws on invalid formulas.
 */
export function renderMath(tex: string): string {
    // German decimal comma: no space after a comma between digits ("4,25", not "4, 25"). The annotation keeps the original input.
    const decimal = tex.replace(/(\d),(?=\d)/g, '$1{,}');
    return temml.renderToString(decimal, { throwOnError: true, annotate: true }).replace(decimal === tex ? /$^/ : />([^<]*)<\/annotation>/, () => `>${escapeXml(tex)}</annotation>`);
}

function escapeXml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Returns the error message for an invalid formula, or undefined if it is valid. */
export function mathError(tex: string): string | undefined {
    try {
        renderMath(tex);
        return undefined;
    } catch (e) {
        return (e instanceof Error ? e.message : String(e)).replace(/^\s*ParseError:\s*/, '').trim();
    }
}
