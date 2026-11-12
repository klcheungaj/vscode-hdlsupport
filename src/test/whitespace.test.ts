// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { selectedLineSpans, spacesToTabs, tabsToSpaces } from '../commands/whitespacePure';

describe('tabsToSpaces', () => {
    it('pads each tab to its tab stop anywhere on the line', () => {
        expect(tabsToSpaces('\tx', 4)).toBe('    x');
        expect(tabsToSpaces('ab\tc\t\td', 4)).toBe('ab  c       d');
    });

    it('keeps line breaks and counts wide characters as two columns', () => {
        expect(tabsToSpaces('a\tb\r\n\tc\n', 4)).toBe('a   b\r\n    c\n');
        expect(tabsToSpaces('中\tx', 4)).toBe('中  x');
    });

    it('falls back to tab size 4 for invalid sizes', () => {
        expect(tabsToSpaces('\tx', Number.NaN)).toBe('    x');
    });
});

describe('spacesToTabs', () => {
    it('converts indentation and alignment runs that reach tab stops', () => {
        expect(spacesToTabs('        x', 4)).toBe('\t\tx');
        expect(spacesToTabs('      x', 4)).toBe('\t  x');
        expect(spacesToTabs('wire  a;', 4)).toBe('wire  a;');
        expect(spacesToTabs('ab      c', 4)).toBe('ab\t\tc');
    });

    it('leaves short runs that do not reach a tab stop, and lone spaces', () => {
        expect(spacesToTabs('a  b', 4)).toBe('a  b');
        expect(spacesToTabs('abc d', 4)).toBe('abc d');
    });

    it('merges a space before a tab into the tab', () => {
        expect(spacesToTabs('abc \tx', 4)).toBe('abc\t\tx');
    });

    it('round-trips with tabsToSpaces', () => {
        const text = '\tmodule m;\n\t\tlogic\ta;\r\nend\n';
        expect(spacesToTabs(tabsToSpaces(text, 4), 4)).toBe(text);
    });

    it('is a no-op with tab size 1', () => {
        expect(spacesToTabs('  x', 1)).toBe('  x');
    });
});

describe('selectedLineSpans', () => {
    const sel = (sl: number, sc: number, el: number, ec: number) => ({
        start: { line: sl, character: sc },
        end: { line: el, character: ec },
    });

    it('merges overlapping and adjacent selections into sorted whole-line spans', () => {
        expect(selectedLineSpans([sel(5, 1, 6, 2), sel(0, 0, 1, 3), sel(2, 0, 2, 1)])).toEqual([
            { startLine: 0, endLine: 2 },
            { startLine: 5, endLine: 6 },
        ]);
    });

    it('excludes the final line of a multi-line selection ending at column 0', () => {
        expect(selectedLineSpans([sel(1, 0, 3, 0)])).toEqual([{ startLine: 1, endLine: 2 }]);
    });
});
