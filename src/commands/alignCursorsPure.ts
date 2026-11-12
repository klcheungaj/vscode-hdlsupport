// SPDX-License-Identifier: MIT
//
// Pure (vscode-free) computation for "HDL Support: Align Cursors".
//
// Alignment rule:
//   * Every selection contributes its START (== the cursor for empty
//     selections) as its reference point; padding is inserted there, so a
//     non-empty selection keeps its extent and is only shifted.
//   * Columns are VISUAL columns (textColumns.ts): a tab advances to the next
//     multiple of `tabSize`, wide CJK characters take two columns. Padding is spaces only.
//   * Selections are grouped by the line of their start. Only the LEFTMOST
//     reference point on each line is used for alignment; any other selection
//     on that line is merely shifted right by the same padding (it keeps its
//     distance to the leftmost one and is NOT individually aligned).
//   * The target column is the maximum reference column over all lines. Each
//     line's leftmost reference point is padded up to it.
//   * Nothing to do (empty result) with fewer than two lines in play or when
//     all reference points already share a column.

import { visualColumn } from './textColumns';

export { visualColumn };

export interface PurePosition {
    line: number;
    character: number;
}

export interface PureSelection {
    anchor: PurePosition;
    active: PurePosition;
}

export interface AlignInsert {
    line: number;
    character: number;
    insertText: string;
}

export interface AlignResult {
    edits: AlignInsert[];
    /** Selections after the edits are applied, in the input order. */
    selections: PureSelection[];
}

const isBefore = (a: PurePosition, b: PurePosition): boolean =>
    a.line < b.line || (a.line === b.line && a.character < b.character);

export function computeAlignCursors(
    getLine: (line: number) => string,
    selections: readonly PureSelection[],
    tabSize: number,
): AlignResult {
    const unchanged: AlignResult = {
        edits: [],
        selections: selections.map(s => ({ anchor: { ...s.anchor }, active: { ...s.active } })),
    };
    if (selections.length < 2) { return unchanged; }

    // Leftmost reference point (selection start) per line.
    const leftmost = new Map<number, number>();
    for (const s of selections) {
        const start = isBefore(s.anchor, s.active) ? s.anchor : s.active;
        const seen = leftmost.get(start.line);
        if (seen === undefined || start.character < seen) {
            leftmost.set(start.line, start.character);
        }
    }

    const columns = new Map<number, number>();
    let target = 0;
    for (const [line, character] of leftmost) {
        const column = visualColumn(getLine(line), character, tabSize);
        columns.set(line, column);
        target = Math.max(target, column);
    }

    const edits: AlignInsert[] = [];
    for (const [line, character] of [...leftmost].sort((a, b) => a[0] - b[0])) {
        const pad = target - (columns.get(line) as number);
        if (pad > 0) { edits.push({ line, character, insertText: ' '.repeat(pad) }); }
    }
    if (edits.length === 0) { return unchanged; }

    // A position moves right by the padding inserted at or before it on its line.
    const padAt = new Map(edits.map(e => [e.line, e] as const));
    const shift = (p: PurePosition): PurePosition => {
        const edit = padAt.get(p.line);
        return edit && p.character >= edit.character
            ? { line: p.line, character: p.character + edit.insertText.length }
            : { ...p };
    };
    return {
        edits,
        selections: selections.map(s => ({ anchor: shift(s.anchor), active: shift(s.active) })),
    };
}
