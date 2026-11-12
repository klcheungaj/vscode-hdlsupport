// SPDX-License-Identifier: MIT
//
// Pure unit tests for the Align Cursors computation (no vscode import).

import { describe, expect, it } from 'vitest';
import { computeAlignCursors, PureSelection, visualColumn } from '../commands/alignCursorsPure';

const cursor = (line: number, character: number): PureSelection => ({
    anchor: { line, character },
    active: { line, character },
});

/** Applies the result's insertions to `lines` (right-to-left per line). */
const apply = (lines: string[], edits: { line: number; character: number; insertText: string }[]): string[] => {
    const out = [...lines];
    for (const e of [...edits].sort((a, b) => b.character - a.character)) {
        out[e.line] = out[e.line].slice(0, e.character) + e.insertText + out[e.line].slice(e.character);
    }
    return out;
};

const run = (lines: string[], sels: PureSelection[], tabSize = 4) =>
    computeAlignCursors(l => lines[l], sels, tabSize);

describe('visualColumn', () => {
    it('expands tabs to the next tab stop', () => {
        expect(visualColumn('\tab', 3, 4)).toBe(6);
        expect(visualColumn('a\tb', 2, 4)).toBe(4);
        expect(visualColumn('ab\t', 3, 8)).toBe(8);
    });
    it('counts wide characters as two columns and falls back on bad tab sizes', () => {
        expect(visualColumn('\u{1F600}x', 3, 4)).toBe(3);
        expect(visualColumn('中a', 2, 4)).toBe(3);
        expect(visualColumn('\ta', 2, Number.NaN)).toBe(5);
    });
});

describe('computeAlignCursors', () => {
    it('is a no-op for a single cursor', () => {
        const r = run(['abc'], [cursor(0, 1)]);
        expect(r.edits).toEqual([]);
        expect(r.selections).toEqual([cursor(0, 1)]);
    });

    it('is a no-op when already aligned', () => {
        const r = run(['abc', 'xyz'], [cursor(0, 2), cursor(1, 2)]);
        expect(r.edits).toEqual([]);
    });

    it('pads shorter columns up to the largest one', () => {
        const lines = ['a = 1', 'bbb = 2', 'cc = 3'];
        const r = run(lines, [cursor(0, 1), cursor(1, 3), cursor(2, 2)]);
        expect(r.edits).toEqual([
            { line: 0, character: 1, insertText: '  ' },
            { line: 2, character: 2, insertText: ' ' },
        ]);
        expect(apply(lines, r.edits)).toEqual(['a   = 1', 'bbb = 2', 'cc  = 3']);
        expect(r.selections).toEqual([cursor(0, 3), cursor(1, 3), cursor(2, 3)]);
    });

    it('aligns by visual column across tabs and spaces, inserting only spaces', () => {
        const lines = ['\tx', '    yy', 'z'];
        // visual columns: 5, 6, 1 -> target 6
        const r = run(lines, [cursor(0, 2), cursor(1, 6), cursor(2, 1)], 4);
        expect(apply(lines, r.edits)).toEqual(['\tx ', '    yy', 'z     ']);
        expect(r.edits.every(e => /^ +$/.test(e.insertText))).toBe(true);
    });

    it('honours the tab size', () => {
        const lines = ['\ta', 'bbbbbbbb'];
        // tab=8 -> col 8 for line 0 after the tab; line 1 offset 8 -> col 8: aligned
        expect(run(lines, [cursor(0, 1), cursor(1, 8)], 8).edits).toEqual([]);
        // tab=4 -> col 4 vs 8: pad 4
        expect(run(lines, [cursor(0, 1), cursor(1, 8)], 4).edits)
            .toEqual([{ line: 0, character: 1, insertText: '    ' }]);
    });

    it('uses only the leftmost cursor per line and shifts the others by the same amount', () => {
        const lines = ['a b c', 'xxxxxx'];
        // line 0 cursors at 1 and 3; line 1 cursor at 4. target = 4.
        const r = run(lines, [cursor(0, 3), cursor(0, 1), cursor(1, 4)]);
        expect(r.edits).toEqual([{ line: 0, character: 1, insertText: '   ' }]);
        expect(apply(lines, r.edits)).toEqual(['a    b c', 'xxxxxx']);
        // input order preserved: the cursor at 3 moves to 6, the one at 1 to 4
        expect(r.selections).toEqual([cursor(0, 6), cursor(0, 4), cursor(1, 4)]);
    });

    it('pads before a non-empty selection start and preserves its extent', () => {
        const lines = ['ab cd', 'wxyz'];
        const sel: PureSelection = { anchor: { line: 0, character: 5 }, active: { line: 0, character: 3 } };
        // reference = start (3); other cursor at col 4 -> pad 1
        const r = run(lines, [sel, cursor(1, 4)]);
        expect(r.edits).toEqual([{ line: 0, character: 3, insertText: ' ' }]);
        expect(r.selections[0]).toEqual({ anchor: { line: 0, character: 6 }, active: { line: 0, character: 4 } });
        expect(r.selections[1]).toEqual(cursor(1, 4));
    });

    it('shifts only the part of a multi-line selection that lies on a padded line after the pad', () => {
        const lines = ['abc', 'defghi'];
        const sel: PureSelection = { anchor: { line: 0, character: 1 }, active: { line: 1, character: 2 } };
        const r = run(lines, [sel, cursor(1, 5)]);
        // refs: line 0 col 1, line 1 col 5 (the cursor; selection ends there but starts on line 0)
        expect(r.edits).toEqual([{ line: 0, character: 1, insertText: '    ' }]);
        expect(r.selections[0]).toEqual({ anchor: { line: 0, character: 5 }, active: { line: 1, character: 2 } });
    });
});
