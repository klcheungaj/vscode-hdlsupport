// SPDX-License-Identifier: MIT
//
// Pure structural-folding computation for Verilog/SystemVerilog sources. This
// file must stay free of `import ... from 'vscode'` so it loads (and is
// unit-tested) in plain Node - jest has no vscode mock; extension.ts wraps the
// returned plain objects in vscode.FoldingRange instances and registers the
// thin provider.
//
// VS Code suppresses its built-in indentation/marker folding whenever ANY
// FoldingRangeProvider is registered for a language, so this scanner also
// reproduces the two behaviors worth keeping from the default folding - `//`
// #region/#endregion markers and comment blocks - next to the structural HDL
// pairs an indentation heuristic cannot see (module/endmodule, begin/end, ...).
//
// Conventions: line numbers are zero-based; every emitted fold EXCLUDES its
// closing keyword/directive line (end = closerLine - 1), matching what LSP
// servers like clangd do for braces, EXCEPT comment blocks which include their
// last line. Single-line spans are never folded.

/** Coarse category hint driving vscode.FoldingRangeKind selection. */
export type FoldingRangeHint = 'comment' | 'region';

/** One computed fold as plain data: zero-based inclusive line span. */
export interface PureFoldingRange {
    start: number;
    end: number;
    kind?: FoldingRangeHint;
}

interface ScanToken {
    /** Lowercased identifier or compiler-directive word (no leading backtick). */
    text: string;
    /** Zero-based line the token starts on. */
    line: number;
    /** True when the token was introduced by a backtick (`ifdef, `else, ...). */
    isDirective: boolean;
}

interface ScanResult {
    tokens: ScanToken[];
    /** True per line containing at least one non-comment, non-blank character. */
    hasCode: readonly boolean[];
    /** True per line contributing to a line or block comment. */
    hasComment: readonly boolean[];
    /** region/endregion marker kind per zero-based marker line. */
    markers: ReadonlyMap<number, 'region' | 'endregion'>;
}

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;
// Same shape the language-configuration folding markers use: "//" plus optional
// "#" before region/endregion, so both styles keep working.
const REGION_MARKER_PATTERN = /^\/\/\s*#?(region|endregion)\b/;

/** Keyword pairs recognized as structural folds; values are the accepted closers. */
const OPENERS_TO_CLOSERS: Readonly<Record<string, readonly string[]>> = {
    module: ['endmodule'],
    macromodule: ['endmodule'],
    class: ['endclass'],
    interface: ['endinterface'],
    program: ['endprogram'],
    package: ['endpackage'],
    checker: ['endchecker'],
    clocking: ['endclocking'],
    config: ['endconfig'],
    generate: ['endgenerate'],
    specify: ['endspecify'],
    primitive: ['endprimitive'],
    table: ['endtable'],
    function: ['endfunction'],
    task: ['endtask'],
    case: ['endcase'],
    casez: ['endcase'],
    casex: ['endcase'],
    begin: ['end'],
    fork: ['join', 'join_any', 'join_none'],
};

const CLOSER_KEYWORDS: ReadonlySet<string> = new Set(
    Object.values(OPENERS_TO_CLOSERS).flat(),
);

/**
 * Single pass over the source splitting each line into code/comment/string
 * segments: collects identifier + directive tokens from code segments only,
 * flags which lines carry code vs. comments, and records //#region markers.
 * Strings end at the closing quote or the newline (Verilog strings never span
 * raw newlines), so one stray quote cannot poison the rest of the file.
 */
function scan(source: string): ScanResult {
    const lines = source.split(/\r\n|\n|\r/);
    const tokens: ScanToken[] = [];
    const hasCode: boolean[] = new Array(lines.length).fill(false);
    const hasComment: boolean[] = new Array(lines.length).fill(false);
    const markers = new Map<number, 'region' | 'endregion'>();

    let inBlockComment = false;
    let inString = false;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        if (inBlockComment) {
            hasComment[lineIndex] = true;
        }
        let i = 0;
        while (i < line.length) {
            const ch = line[i];
            if (inBlockComment) {
                if (ch === '*' && line[i + 1] === '/') {
                    inBlockComment = false;
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if (inString) {
                if (ch === '\\') {
                    i += 2;
                    continue;
                }
                if (ch === '"') {
                    inString = false;
                }
                i += 1;
                continue;
            }
            if (ch === '/' && line[i + 1] === '/') {
                hasComment[lineIndex] = true;
                const markerMatch = REGION_MARKER_PATTERN.exec(line.slice(i));
                if (markerMatch) {
                    markers.set(lineIndex, markerMatch[1] as 'region' | 'endregion');
                }
                break;
            }
            if (ch === '/' && line[i + 1] === '*') {
                inBlockComment = true;
                hasComment[lineIndex] = true;
                i += 2;
                continue;
            }
            if (ch === '"') {
                inString = true;
                hasCode[lineIndex] = true;
                i += 1;
                continue;
            }
            if (ch === '`') {
                let j = i + 1;
                while (j < line.length && IDENTIFIER_CHAR.test(line[j])) {
                    j += 1;
                }
                const word = line.slice(i + 1, j);
                if (word) {
                    tokens.push({ text: word.toLowerCase(), line: lineIndex, isDirective: true });
                    // Directive/macro text counts as code: comment-block runs
                    // must never continue across a `` `ifdef``/`` `else``/
                    // `` `endif`` boundary, or the resulting comment fold would
                    // partially overlap the directive-segment folds.
                    hasCode[lineIndex] = true;
                }
                i = j;
                continue;
            }
            if (IDENTIFIER_START.test(ch)) {
                let j = i + 1;
                while (j < line.length && IDENTIFIER_CHAR.test(line[j])) {
                    j += 1;
                }
                tokens.push({ text: line.slice(i, j).toLowerCase(), line: lineIndex, isDirective: false });
                hasCode[lineIndex] = true;
                i = j;
                continue;
            }
            if (!/\s/.test(ch)) {
                hasCode[lineIndex] = true;
            }
            i += 1;
        }
        // Verilog strings never span a raw newline; closing the state per line
        // keeps one stray quote from poisoning the rest of the file.
        inString = false;
    }
    return { tokens, hasCode, hasComment, markers };
}

/**
 * Matches structural keyword pairs with a stack: each closer pops the nearest
 * open frame accepting it, discarding unmatched inner frames, so broken code
 * degrades gracefully instead of producing bogus giant folds. Unclosed frames
 * at EOF simply emit nothing.
 */
function pairKeywordBlocks(tokens: readonly ScanToken[]): PureFoldingRange[] {
    const ranges: PureFoldingRange[] = [];
    const stack: Array<{ line: number; closers: readonly string[] }> = [];
    for (const token of tokens) {
        if (token.isDirective) {
            continue;
        }
        const closers = OPENERS_TO_CLOSERS[token.text];
        if (closers) {
            stack.push({ line: token.line, closers });
            continue;
        }
        if (!CLOSER_KEYWORDS.has(token.text)) {
            continue;
        }
        let index = stack.length - 1;
        while (index >= 0 && !stack[index].closers.includes(token.text)) {
            index -= 1;
        }
        if (index < 0) {
            continue;
        }
        const frame = stack[index];
        stack.length = index;
        const end = token.line - 1;
        if (end > frame.line) {
            ranges.push({ start: frame.line, end });
        }
    }
    return ranges;
}

/**
 * Folds conditional-compilation regions: `` `ifdef``/`` `ifndef`` opens a frame,
 * `` `elsif``/`` `else`` closes the current segment and reopens at their own line,
 * `` `endif`` closes the last segment. Procedural `else` keywords carry no
 * backtick and never enter here (see scan's directive detection).
 */
function directiveRegions(tokens: readonly ScanToken[]): PureFoldingRange[] {
    const ranges: PureFoldingRange[] = [];
    const stack: number[] = [];
    for (const token of tokens) {
        if (!token.isDirective) {
            continue;
        }
        switch (token.text) {
            case 'ifdef':
            case 'ifndef':
                stack.push(token.line);
                break;
            case 'elsif':
            case 'else': {
                const frameStart = stack[stack.length - 1];
                if (frameStart === undefined || token.line - 1 <= frameStart) {
                    break;
                }
                ranges.push({ start: frameStart, end: token.line - 1 });
                stack[stack.length - 1] = token.line;
                break;
            }
            case 'endif': {
                const frameStart = stack.pop();
                if (frameStart === undefined || token.line - 1 <= frameStart) {
                    break;
                }
                ranges.push({ start: frameStart, end: token.line - 1 });
                break;
            }
            default:
                break;
        }
    }
    return ranges;
}

/** Pairs //#region ... //#endregion markers; unmatched markers are ignored. */
function markerRegions(markers: ReadonlyMap<number, 'region' | 'endregion'>): PureFoldingRange[] {
    const ranges: PureFoldingRange[] = [];
    const openStarts: number[] = [];
    const sortedLines = [...markers.keys()].sort((a, b) => a - b);
    for (const line of sortedLines) {
        if (markers.get(line) === 'region') {
            openStarts.push(line);
            continue;
        }
        const start = openStarts.pop();
        if (start === undefined || line - 1 <= start) {
            continue;
        }
        ranges.push({ start, end: line - 1, kind: 'region' });
    }
    return ranges;
}

/**
 * Folds runs of consecutive comment-only lines (line comments and block
 * comments alike): trailing blank lines are trimmed away, at least two comment
 * lines are required, and runs containing //#region markers are skipped so
 * they cannot partially overlap the region folds.
 */
function commentBlocks(
    lines: readonly string[],
    hasCode: readonly boolean[],
    hasComment: readonly boolean[],
    markers: ReadonlyMap<number, unknown>,
): PureFoldingRange[] {
    const ranges: PureFoldingRange[] = [];
    let runStart = -1;
    const flushRun = (runEndExclusive: number): void => {
        if (runStart < 0) {
            return;
        }
        let start = runStart;
        let end = runEndExclusive - 1;
        while (start <= end && lines[start].trim() === '') {
            start += 1;
        }
        while (end >= start && lines[end].trim() === '') {
            end -= 1;
        }
        let hasCommentLine = false;
        let containsMarker = false;
        for (let line = start; line <= end; line++) {
            hasCommentLine ||= hasComment[line];
            containsMarker ||= markers.has(line);
        }
        if (hasCommentLine && !containsMarker && end > start) {
            ranges.push({ start, end, kind: 'comment' });
        }
        runStart = -1;
    };
    for (let line = 0; line < lines.length; line++) {
        if (!hasCode[line]) {
            if (runStart < 0) {
                runStart = line;
            }
            continue;
        }
        flushRun(line);
    }
    flushRun(lines.length);
    return ranges;
}

/**
 * Computes all folding ranges for one Verilog/SystemVerilog document:
 * structural keyword pairs, `ifdef/`ifndef/`elsif/`else/`endif segments,
 * //#region markers and comment blocks. Output is sorted by start position
 * (outer folds first on ties) and contains no empty spans.
 */
export function computeVerilogFoldingRanges(source: string): PureFoldingRange[] {
    if (!source) {
        return [];
    }
    const { tokens, hasCode, hasComment, markers } = scan(source);
    const lines = source.split(/\r\n|\n|\r/);
    const ranges = [
        ...pairKeywordBlocks(tokens),
        ...directiveRegions(tokens),
        ...markerRegions(markers),
        ...commentBlocks(lines, hasCode, hasComment, markers),
    ].filter((range) => range.end > range.start);
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    return ranges;
}
