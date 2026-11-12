// SPDX-License-Identifier: MIT
//
// Pure unit tests for the client-side Verilog/SystemVerilog folding scanner.
// Expectations use zero-based inclusive line spans where every structural fold
// EXCLUDES its closing keyword/directive line (the clangd convention), while
// comment blocks include their last line.

import { describe, expect, it } from 'vitest';
import { computeVerilogFoldingRanges, PureFoldingRange } from '../clientFeatures/foldingRanges';

const lines = (...rows: string[]): string => rows.join('\n');

/** Fails unless every range pair is nested or disjoint; VS Code corrupts the
 *  gutter when folding ranges partially overlap. */
const expectNestedOrDisjoint = (ranges: PureFoldingRange[]): void => {
    for (let i = 0; i < ranges.length; i++) {
        for (let j = i + 1; j < ranges.length; j++) {
            const a = ranges[i];
            const b = ranges[j];
            const disjoint = a.end < b.start || b.end < a.start;
            const aInsideB = a.start >= b.start && a.end <= b.end;
            const bInsideA = b.start >= a.start && b.end <= a.end;
            if (!disjoint && !aInsideB && !bInsideA) {
                throw new Error(
                    `partial overlap between ${JSON.stringify(a)} and ${JSON.stringify(b)}`,
                );
            }
        }
    }
};

describe('computeVerilogFoldingRanges: structural keyword pairs', () => {
    it('folds a module up to (excluding) its endmodule', () => {
        const src = lines(
            'module counter #(parameter int W = 8)(input logic clk);',
            '  logic [7:0] q;',
            'endmodule',
        );
        expect(computeVerilogFoldingRanges(src)).toEqual([{ start: 0, end: 1 }]);
    });

    it('handles multi-line module headers', () => {
        const src = lines(
            'module big',
            '  #(parameter int W = 4)',
            '  (input logic clk);',
            '  assign y = 1;',
            'endmodule',
        );
        expect(computeVerilogFoldingRanges(src)).toEqual([{ start: 0, end: 3 }]);
    });

    it('nests begin/end blocks inside a module', () => {
        const src = lines(
            'module m;',
            '  always @* begin',
            '    if (x) begin',
            '      y = 1;',
            '    end',
            '  end',
            'endmodule',
        );
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 5 },
            { start: 1, end: 4 },
            { start: 2, end: 3 },
        ]);
    });

    it('matches named blocks (begin : name / end : name)', () => {
        const src = lines(
            'module m;',
            '  begin : blk',
            '    x = 1;',
            '  end : blk',
            'endmodule',
        );
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 3 },
            { start: 1, end: 2 },
        ]);
    });

    it('pairs case/casez/casex with endcase', () => {
        const src = lines(
            'module m;',
            '  always_comb begin',
            '    case (sel)',
            "      2'b00: y = 0;",
            '      default: y = 1;',
            '    endcase',
            '  end',
            'endmodule',
        );
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 6 },
            { start: 1, end: 5 },
            { start: 2, end: 4 },
        ]);

        const casezSrc = lines('module n;', '  always_comb begin', '    casez (s)', '    endcase', '  end', 'endmodule');
        expect(computeVerilogFoldingRanges(casezSrc)).toEqual([
            { start: 0, end: 4 },
            { start: 1, end: 3 },
        ]);
        const casexSrc = lines('module o;', '  always_comb begin', '    casex (s)', '    endcase', '  end', 'endmodule');
        expect(computeVerilogFoldingRanges(casexSrc)).toEqual([
            { start: 0, end: 4 },
            { start: 1, end: 3 },
        ]);
    });

    it('folds functions and tasks including their inner blocks', () => {
        const src = lines(
            'module m;',
            '  function automatic int f(int a);',
            '    int b;',
            '    begin',
            '      b = a + 1;',
            '      return b;',
            '    end',
            '  endfunction',
            '  task t();',
            '    $display("hi");',
            '  endtask',
            'endmodule',
        );
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 10 },
            { start: 1, end: 6 },
            { start: 3, end: 5 },
            { start: 8, end: 9 },
        ]);
    });

    it('folds classes, interfaces, packages, generate and fork families', () => {
        const cls = lines(
            'class foo extends bar;',
            '  int count;',
            '  function new();',
            '    count = 0;',
            '  endfunction',
            'endclass',
        );
        expect(computeVerilogFoldingRanges(cls)).toEqual([
            { start: 0, end: 4 },
            { start: 2, end: 3 },
        ]);

        const fork = lines(
            'initial begin',
            '  fork',
            '    send();',
            '  join_none',
            'end',
        );
        expect(computeVerilogFoldingRanges(fork)).toEqual([
            { start: 0, end: 3 },
            { start: 1, end: 2 },
        ]);

        const generate = lines('module g;', '  generate', '    genvar i;', '  endgenerate', 'endmodule');
        expect(computeVerilogFoldingRanges(generate)).toEqual([
            { start: 0, end: 3 },
            { start: 1, end: 2 },
        ]);
    });
});

describe('computeVerilogFoldingRanges: comments and strings', () => {
    it('ignores keywords in line and block comments', () => {
        const src = lines(
            '// module fake(',
            '/* end */',
            'module real_m;',
            '  // begin ghost',
            '  /* case never */',
            '  assign z = 1;',
            'endmodule',
        );
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 1, kind: 'comment' },
            { start: 2, end: 5 },
            { start: 3, end: 4, kind: 'comment' },
        ]);
    });

    it('ignores keywords inside strings', () => {
        const src = lines(
            'module m;',
            '  initial $display("endmodule begin end");',
            'endmodule',
        );
        expect(computeVerilogFoldingRanges(src)).toEqual([{ start: 0, end: 1 }]);
    });

    it('does not let an unterminated string poison following lines', () => {
        const src = lines(
            'module m;',
            '  initial $display("oops',
            '  logic q;',
            'endmodule',
        );
        expect(computeVerilogFoldingRanges(src)).toEqual([{ start: 0, end: 2 }]);
    });

    it('folds consecutive line-comment banners and trims trailing blanks', () => {
        const src = lines(
            '// Header line one',
            '// Header line two',
            '',
            'module m;',
            '  assign x = 1;',
            'endmodule',
        );
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 1, kind: 'comment' },
            { start: 3, end: 4 },
        ]);
    });

    it('keeps interior blank lines inside comment runs', () => {
        const src = lines('// a', '', '// b', 'assign x = 1;');
        expect(computeVerilogFoldingRanges(src)).toEqual([{ start: 0, end: 2, kind: 'comment' }]);
    });

    it('never folds single-line comments or pure blank files', () => {
        expect(computeVerilogFoldingRanges(lines('// just one', 'assign a = 1;'))).toEqual([]);
        expect(computeVerilogFoldingRanges(lines('', ''))).toEqual([]);
        expect(computeVerilogFoldingRanges('')).toEqual([]);
    });

    it('folds multi-line block comments', () => {
        const src = lines('/* doc', '   more', ' */', 'module m;', 'endmodule');
        expect(computeVerilogFoldingRanges(src)).toEqual([{ start: 0, end: 2, kind: 'comment' }]);
    });

    it('treats a marker inside a block comment as plain comment text', () => {
        const src = lines('/*', '// #region ghost', '*/', 'assign a = 1;');
        expect(computeVerilogFoldingRanges(src)).toEqual([{ start: 0, end: 2, kind: 'comment' }]);
    });
});

describe('computeVerilogFoldingRanges: compiler directives', () => {
    it('splits ifdef/else/endif into segments excluding the directive lines', () => {
        const src = lines('`ifdef SYNTHESIS', '  assign a = 1;', '`else', '  assign a = 0;', '`endif');
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 1 },
            { start: 2, end: 3 },
        ]);
    });

    it('chains ifndef/elsif/else segments', () => {
        const src = lines('`ifndef A', '  a1', '`elsif B', '  b1', '`else', '  c1', '`endif');
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 1 },
            { start: 2, end: 3 },
            { start: 4, end: 5 },
        ]);
    });

    it('supports nested conditional regions', () => {
        const src = lines('`ifdef A', '`ifdef B', 'ab', '`endif', 'outer', '`endif');
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 4 },
            { start: 1, end: 2 },
        ]);
    });

    it('ignores stray endif and unterminated ifdef frames', () => {
        expect(computeVerilogFoldingRanges(lines('`endif', 'assign x = 1;'))).toEqual([]);
        expect(computeVerilogFoldingRanges(lines('`ifdef X', 'assign x = 1;'))).toEqual([]);
    });

    it('never treats a procedural else as a compiler directive', () => {
        const src = lines(
            'module m;',
            '  always @* begin',
            '    if (s) y = 1;',
            '    else y = 2;',
            '  end',
            'endmodule',
        );
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 4 },
            { start: 1, end: 3 },
        ]);
    });

    it('ignores non-conditional macro usage like `WIDTH', () => {
        const src = lines('module m;', '  assign y = `WIDTH;', 'endmodule');
        expect(computeVerilogFoldingRanges(src)).toEqual([{ start: 0, end: 1 }]);
    });
});

describe('computeVerilogFoldingRanges: //#region markers', () => {
    it('pairs region/endregion markers with and without the hash', () => {
        const hashed = lines('// #region Alu', 'assign x = 1;', '// #endregion');
        expect(computeVerilogFoldingRanges(hashed)).toEqual([{ start: 0, end: 1, kind: 'region' }]);

        const plain = lines('// region one', 'x = 1;', '// endregion');
        expect(computeVerilogFoldingRanges(plain)).toEqual([{ start: 0, end: 1, kind: 'region' }]);
    });

    it('ignores unmatched markers and unterminated regions', () => {
        const src = lines('// #endregion', 'assign a = 1;', '// #region', 'assign b = 2;');
        expect(computeVerilogFoldingRanges(src)).toEqual([]);
    });

    it('suppresses overlapping comment folds around marker lines', () => {
        const src = lines('// #region Alu', '// helper', 'assign x = 1;', '// #endregion');
        expect(computeVerilogFoldingRanges(src)).toEqual([{ start: 0, end: 2, kind: 'region' }]);
    });
});

describe('computeVerilogFoldingRanges: robustness', () => {
    it('drops unbalanced inner frames without inventing giant folds', () => {
        const src = lines('module m;', '  begin', '    assign a = 1;', 'endmodule');
        expect(computeVerilogFoldingRanges(src)).toEqual([{ start: 0, end: 2 }]);
    });

    it('ignores closers without openers', () => {
        expect(computeVerilogFoldingRanges(lines('end', 'endmodule'))).toEqual([]);
    });

    it('skips constructs opening and closing on the same line', () => {
        const src = lines('module m; endmodule', 'assign a = 1;');
        expect(computeVerilogFoldingRanges(src)).toEqual([]);
        expect(computeVerilogFoldingRanges(lines('module m;', 'endmodule'))).toEqual([]);
    });

    it('splits CRLF line endings like LF ones', () => {
        expect(computeVerilogFoldingRanges('module m;\r\nassign x;\r\nendmodule')).toEqual([
            { start: 0, end: 1 },
        ]);
    });

    it('returns deterministic sorted output with no empty spans', () => {
        const src = lines(
            '// banner',
            'package p;',
            '  function f();',
            '    return 1;',
            '  endfunction',
            'endpackage',
            'module z;',
            'endmodule',
        );
        const first = computeVerilogFoldingRanges(src);
        const second = computeVerilogFoldingRanges(src);
        expect(first).toEqual(second);
        expect(first).toEqual([
            { start: 1, end: 4 },
            { start: 2, end: 3 },
        ]);
    });
});

describe('computeVerilogFoldingRanges: comment folds vs directive regions', () => {
    it('never builds a comment fold across bare directive lines (`else repro)', () => {
        // Regression: `` `else``/`` `endif`` lines used to count as non-code,
        // so the "// tail" run continued past them and its comment fold
        // [2,5] partially overlapped the directive folds [0,2] and [3,4].
        const src = lines('`ifdef A', 'wire w;', '// tail', '`else', '// head', '`endif');
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 2 },
            { start: 3, end: 4 },
        ]);
    });

    it('never builds a comment fold across a doc comment / `elsif chain (`elsif repro)', () => {
        // Regression: the "// b-doc" run used to swallow the `` `endif`` line
        // and fold [4,5], sharing line 4 with the directive fold [3,4].
        const src = lines('// doc', '`ifdef A', '// a-doc', '`elsif B', '// b-doc', '`endif');
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 1, end: 2 },
            { start: 3, end: 4 },
        ]);
    });

    it('still folds multi-line comments living entirely inside one directive segment', () => {
        const src = lines('`ifdef A', '// a', '// b', '`endif', 'assign w;');
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 2 },
            { start: 1, end: 2, kind: 'comment' },
        ]);
    });

    it('still folds header comments stacked directly above a conditional region', () => {
        const src = lines('// header', '// more', '`ifdef A', 'wire w;', '`endif');
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 1, kind: 'comment' },
            { start: 2, end: 3 },
        ]);
    });

    it('still folds a trailing comment banner after `endif', () => {
        const src = lines('`ifdef A', 'wire w;', '`endif', '// footer', '// more footer', 'assign x;');
        expect(computeVerilogFoldingRanges(src)).toEqual([
            { start: 0, end: 1 },
            { start: 3, end: 4, kind: 'comment' },
        ]);
    });
});

describe('computeVerilogFoldingRanges: nesting postcondition corpus', () => {
    const CORPUS: string[] = [
        lines(
            'module counter #(parameter int W = 8)(input logic clk);',
            '  logic [7:0] q;',
            'endmodule',
        ),
        lines(
            'module m;',
            '  always @* begin',
            '    if (x) begin',
            '      y = 1;',
            '    end',
            '  end',
            'endmodule',
        ),
        lines(
            '// module fake(',
            '/* end */',
            'module real_m;',
            '  // begin ghost',
            '  /* case never */',
            '  assign z = 1;',
            'endmodule',
        ),
        lines('`ifdef SYNTHESIS', '  assign a = 1;', '`else', '  assign a = 0;', '`endif'),
        lines('`ifndef A', '  a1', '`elsif B', '  b1', '`else', '  c1', '`endif'),
        lines('`ifdef A', '`ifdef B', 'ab', '`endif', 'outer', '`endif'),
        lines('`ifdef A', 'wire w;', '// tail', '`else', '// head', '`endif'),
        lines('// doc', '`ifdef A', '// a-doc', '`elsif B', '// b-doc', '`endif'),
        lines('`ifdef A', '// a', '// b', '`endif', 'assign w;'),
        lines('// #region Alu', '// helper', 'assign x = 1;', '// #endregion'),
        lines('// Header line one', '// Header line two', '', 'module m;', '  assign x = 1;', 'endmodule'),
        lines('/* doc', '   more', ' */', 'module m;', 'endmodule'),
        lines('module m;', '  initial $display("oops', '  logic q;', 'endmodule'),
        lines('module m;', '  begin', '    assign a = 1;', 'endmodule'),
        lines('module m;\r\nassign x;\r\nendmodule'),
    ];

    it('keeps every range pair nested or disjoint across the whole corpus', () => {
        for (const source of CORPUS) {
            expectNestedOrDisjoint(computeVerilogFoldingRanges(source));
        }
    });

    it('keeps ranges nested or disjoint when corpus members are concatenated', () => {
        for (const head of CORPUS) {
            for (const tail of CORPUS) {
                expectNestedOrDisjoint(computeVerilogFoldingRanges(`${head}\n${tail}`));
            }
        }
    });

    it('emits sorted non-empty spans with structural folds before inner ones on ties', () => {
        for (const source of [...CORPUS, ...CORPUS.map((head) => `${head}\n${head}`)]) {
            const ranges = computeVerilogFoldingRanges(source);
            for (const range of ranges) {
                expect(range.end).toBeGreaterThan(range.start);
            }
            const sorted = [...ranges].sort((a, b) => a.start - b.start || b.end - a.end);
            expect(ranges).toEqual(sorted);
        }
    });
});
