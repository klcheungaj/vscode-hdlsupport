// SPDX-License-Identifier: MIT
//
// Pure visual-column helpers shared by Align Cursors and the whitespace
// converters. Must not import vscode.

const DEFAULT_TAB_SIZE = 4;

/** A positive integer tab size, else the editor default of 4. */
export function normalizeTabSize(tabSize: number): number {
    return Number.isInteger(tabSize) && tabSize >= 1 ? tabSize : DEFAULT_TAB_SIZE;
}

// East Asian wide/full-width blocks rendered two columns wide.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x1100, 0x115f], [0x2e80, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
    [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
    [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

/** Columns occupied by one non-tab code point: 0 for control characters,
 *  2 for wide characters, else 1. */
export function charColumns(char: string): number {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
        return 0;
    }
    return WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
}

/** Column reached after a tab starting at `column`. */
export function nextTabStop(column: number, tabSize: number): number {
    return column + tabSize - (column % tabSize);
}

/** Visual column of UTF-16 offset `character` within `text`. */
export function visualColumn(text: string, character: number, tabSize: number): number {
    const size = normalizeTabSize(tabSize);
    return [...text.slice(0, character)].reduce(
        (column, char) => (char === '\t' ? nextTabStop(column, size) : column + charColumns(char)),
        0,
    );
}
