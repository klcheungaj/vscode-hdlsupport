// SPDX-License-Identifier: MIT

import { maskComments } from './verilogStructure';

export interface LiteralInclude {
    path: string;
    start: number;
    end: number;
}

/** Finds only literal `include "..." directives and preserves source offsets. */
export function extractLiteralIncludes(source: string): LiteralInclude[] {
    const masked = maskComments(source);
    const includes: LiteralInclude[] = [];
    const pattern = /^[ \t]*`include[ \t]+"([^"\r\n]+)"/gm;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked)) !== null) {
        const relativeStart = match[0].indexOf(match[1]);
        const start = match.index + relativeStart;
        includes.push({ path: source.slice(start, start + match[1].length), start, end: start + match[1].length });
    }
    return includes;
}
