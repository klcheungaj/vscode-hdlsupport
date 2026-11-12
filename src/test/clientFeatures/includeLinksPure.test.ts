// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { extractLiteralIncludes } from '../../clientFeatures/includeLinksPure';

describe('literal Verilog include links', () => {
    it('finds quoted includes and returns exact path offsets', () => {
        const source = '`include "defs.svh"\n  `include "sub/regs.vh"\n';
        const includes = extractLiteralIncludes(source);

        expect(includes.map((entry) => entry.path)).toEqual(['defs.svh', 'sub/regs.vh']);
        for (const include of includes) {
            expect(source.slice(include.start, include.end)).toBe(include.path);
        }
    });

    it('ignores commented and macro-expanded includes', () => {
        const source = '// `include "old.svh"\n/* `include "hidden.svh" */\n`include HEADER_FILE\n';

        expect(extractLiteralIncludes(source)).toEqual([]);
    });

    it('does not confuse comment markers inside strings with real comments', () => {
        const source = '$display("// text");\nstring directive = "`include \\"fake.svh\\"";\n`include "live.svh"\n';

        expect(extractLiteralIncludes(source).map((entry) => entry.path)).toEqual(['live.svh']);
    });

    it('supports whitespace between the directive and path', () => {
        expect(extractLiteralIncludes('`include\t  "defs.svh"')).toEqual([
            { path: 'defs.svh', start: 12, end: 20 },
        ]);
    });
});
