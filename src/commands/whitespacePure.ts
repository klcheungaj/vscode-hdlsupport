// SPDX-License-Identifier: MIT
//
// Pure tab <-> space conversion that honours tab stops anywhere on a line
// (not only leading indentation). Must not import vscode.
import { charColumns, nextTabStop, normalizeTabSize } from './textColumns';

export type WhitespaceMode = 'tabsToSpaces' | 'spacesToTabs';

/** Applies `convertLine` to every line, keeping the original line breaks. */
function mapLines(text: string, convertLine: (line: string) => string): string {
    return text.split(/(\r?\n)/).map((part, index) => (index % 2 === 0 ? convertLine(part) : part)).join('');
}

/** Replaces each tab with the spaces needed to reach its tab stop. */
export function tabsToSpaces(text: string, tabSize: number): string {
    const size = normalizeTabSize(tabSize);
    return mapLines(text, (line) => {
        let column = 0;
        return [...line].map((char) => {
            if (char !== '\t') {
                column += charColumns(char);
                return char;
            }
            const stop = nextTabStop(column, size);
            const spaces = ' '.repeat(stop - column);
            column = stop;
            return spaces;
        }).join('');
    });
}

/** Re-encodes one blank run spanning columns [start, end) with tabs at every
 *  tab stop it crosses plus trailing spaces. A run that is a single space
 *  (ending exactly on a tab stop) stays a space. */
function encodeBlankRun(run: string, start: number, end: number, size: number): string {
    const firstStop = nextTabStop(start, size);
    if (firstStop > end || run === ' ') {
        return run;
    }
    const tabCount = 1 + Math.floor((end - firstStop) / size);
    return '\t'.repeat(tabCount) + ' '.repeat(end - (firstStop + (tabCount - 1) * size));
}

/** Replaces runs of blanks that reach a tab stop with tabs. */
export function spacesToTabs(text: string, tabSize: number): string {
    const size = normalizeTabSize(tabSize);
    if (size === 1) {
        return text;
    }
    return mapLines(text, (line) => {
        let column = 0;
        return (line.match(/[ \t]+|[^ \t]+/g) ?? []).map((segment) => {
            const start = column;
            if (!/^[ \t]/.test(segment)) {
                column += [...segment].reduce((width, char) => width + charColumns(char), 0);
                return segment;
            }
            column = [...segment].reduce((col, char) => (char === '\t' ? nextTabStop(col, size) : col + 1), column);
            return encodeBlankRun(segment, start, column, size);
        }).join('');
    });
}

export function convertWhitespace(mode: WhitespaceMode, text: string, tabSize: number): string {
    return mode === 'tabsToSpaces' ? tabsToSpaces(text, tabSize) : spacesToTabs(text, tabSize);
}

export interface LineSpan {
    startLine: number;
    /** Inclusive. */
    endLine: number;
}

/** Whole-line spans covered by the selections, sorted and merged. A
 *  multi-line selection ending at column 0 does not include that last line. */
export function selectedLineSpans(
    selections: ReadonlyArray<{ start: { line: number; character: number }; end: { line: number; character: number } }>,
): LineSpan[] {
    return selections
        .map(({ start, end }) => ({
            startLine: start.line,
            endLine: end.line > start.line && end.character === 0 ? end.line - 1 : end.line,
        }))
        .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
        .reduce<LineSpan[]>((spans, span) => {
            const last = spans.at(-1);
            if (last && span.startLine <= last.endLine + 1) {
                last.endLine = Math.max(last.endLine, span.endLine);
            } else {
                spans.push({ ...span });
            }
            return spans;
        }, []);
}
