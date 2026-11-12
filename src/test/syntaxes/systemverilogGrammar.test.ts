import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { innermostScope, tokenize, tokenWithText, tokensWithScope, type ScopedToken } from './grammarHarness';

const SV = 'source.systemverilog';

const contributes = (
    JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
        contributes: { semanticTokenScopes?: { language: string; scopes: Record<string, string[]> }[] };
    }
).contributes;

/**
 * The TextMate scope llg_ls keyword tokens resolve to for `systemverilog`, so
 * the grammar previews exactly the color the semantic token later paints.
 */
function semanticScope(selector: string): string {
    const scopes = contributes.semanticTokenScopes?.find((entry) => entry.language === 'systemverilog')?.scopes;
    const scope = scopes?.[selector]?.[0];
    if (scope === undefined) {
        throw new Error(`package.json maps no scope for ${selector}`);
    }
    return scope;
}

// The llg_ls keyword classes (lapligence docs/semantic_tokens.md ST-03..ST-09).
const KEYWORD_CLASSES: [string, string[]][] = [
    ['keyword.controlFlow', [
        'if', 'else', 'case', 'casex', 'casez', 'randcase', 'endcase', 'for', 'foreach', 'while', 'do', 'repeat',
        'forever', 'return', 'break', 'continue', 'wait', 'wait_order', 'initial', 'final', 'always', 'always_comb',
        'always_ff', 'always_latch', 'assign', 'deassign', 'force', 'release', 'alias', 'assert', 'assume', 'cover',
        'restrict', 'expect',
    ]],
    ['keyword.typeDefinition', ['typedef', 'struct', 'union', 'enum']],
    ['keyword.direction', ['input', 'output', 'inout', 'ref']],
    ['keyword.primitive', [
        'parameter', 'localparam', 'specparam', 'const', 'var', 'bit', 'logic', 'reg', 'byte', 'shortint', 'int',
        'longint', 'integer', 'time', 'shortreal', 'real', 'realtime', 'string', 'chandle', 'event', 'void', 'signed',
        'unsigned', 'genvar', 'supply0', 'supply1', 'tri', 'triand', 'trior', 'trireg', 'tri0', 'tri1', 'uwire', 'wire',
        'wand', 'wor', 'automatic', 'static',
    ]],
];

// IEEE 1800-2017 Annex B reserved keywords.
const IEEE_KEYWORDS = `accept_on alias always always_comb always_ff always_latch and assert assign assume automatic before
begin bind bins binsof bit break buf bufif0 bufif1 byte case casex casez cell chandle checker class clocking cmos config
const constraint context continue cover covergroup coverpoint cross deassign default defparam design disable dist do edge
else end endcase endchecker endclass endclocking endconfig endfunction endgenerate endgroup endinterface endmodule
endpackage endprimitive endprogram endproperty endspecify endsequence endtable endtask enum event eventually expect export
extends extern final first_match for force foreach forever fork forkjoin function generate genvar global highz0 highz1 if
iff ifnone ignore_bins illegal_bins implements implies import incdir include initial inout input inside instance int
integer interconnect interface intersect join join_any join_none large let liblist library local localparam logic longint
macromodule matches medium modport module nand negedge nettype new nexttime nmos nor noshowcancelled not notif0 notif1
null or output package packed parameter pmos posedge primitive priority program property protected pull0 pull1 pulldown
pullup pulsestyle_ondetect pulsestyle_onevent pure rand randc randcase randsequence rcmos real realtime ref reg reject_on
release repeat restrict return rnmos rpmos rtran rtranif0 rtranif1 s_always s_eventually s_nexttime s_until s_until_with
scalared sequence shortint shortreal showcancelled signed small soft solve specify specparam static string strong strong0
strong1 struct super supply0 supply1 sync_accept_on sync_reject_on table tagged task this throughout time timeprecision
timeunit tran tranif0 tranif1 tri tri0 tri1 triand trior trireg type typedef union unique unique0 unsigned until
until_with untyped use uwire var vectored virtual void wait wait_order wand weak weak0 weak1 while wildcard wire with
within wor xnor xor`.split(/\s+/);

function selectorForKeyword(word: string): string {
    // `default` and `unique`/`priority`/`disable` depend on position; alone
    // they take the class they have in most code.
    if (word === 'default' || word === 'disable') {
        return 'keyword.controlFlow';
    }
    return KEYWORD_CLASSES.find(([, words]) => words.includes(word))?.[0] ?? 'keyword';
}

async function scopeOf(lines: string[], text: string, occurrence = 0): Promise<string | undefined> {
    const tokens = (await tokenize(SV, lines)).flat().filter((token) => token.text === text);
    expect(tokens.length, `token ${JSON.stringify(text)}`).toBeGreaterThan(occurrence);
    return innermostScope(tokens[occurrence]);
}

describe('SystemVerilog TextMate grammar', () => {
    it('gives every IEEE keyword the scope of its llg_ls keyword class', async () => {
        const lines = await tokenize(SV, IEEE_KEYWORDS.map((word) => ` ${word} `));
        const mismatches = IEEE_KEYWORDS.flatMap((word, index) => {
            const token = lines[index].find((candidate) => candidate.text === word);
            const expected = semanticScope(selectorForKeyword(word));
            const actual = token === undefined ? undefined : innermostScope(token);
            return actual === expected ? [] : [`${word}: ${actual} (expected ${expected})`];
        });
        expect(mismatches).toEqual([]);
    });

    it('classifies positional keywords like llg_ls', async () => {
        const control = semanticScope('keyword.controlFlow');
        const plain = semanticScope('keyword');
        const primitive = semanticScope('keyword.primitive');
        const source = [
            'unique case (s) 0: x = 1; default: x = 0; endcase',
            "logic [3:0] a = '{default: 0};",
            'constraint c { unique {a, b}; }',
            'property p; @(posedge clk) disable iff (rst) a; endproperty',
            'default clocking cb @(posedge clk); endclocking',
            'assert final (x);',
        ];
        expect(await scopeOf(source, 'unique')).toBe(control);
        expect(await scopeOf(source, 'default', 0)).toBe(control);
        expect(await scopeOf(source, 'default', 1)).toBe(primitive);
        expect(await scopeOf(source, 'unique', 1)).toBe(plain);
        expect(await scopeOf(source, 'disable')).toBe(plain);
        expect(await scopeOf(source, 'default', 2)).toBe(primitive);
        expect(await scopeOf(source, 'final')).toBe(plain);
    });

    it('colors directives as control flow and macro names as plain keywords', async () => {
        const control = semanticScope('keyword.controlFlow');
        const plain = semanticScope('keyword');
        const lines = await tokenize(SV, [
            '`define WIDTH 8',
            '`ifdef WIDTH',
            'assign w = `WIDTH + 1;',
            '`endif',
            '`default_nettype none',
            '`include "defs.svh"',
        ]);
        for (const directive of ['`define', '`ifdef', '`endif', '`default_nettype', '`include']) {
            expect(innermostScope(tokenWithText(lines, directive)), directive).toBe(control);
        }
        expect(tokensWithScope(lines, plain).map((token) => token.text)).toEqual(['WIDTH', 'WIDTH', '`WIDTH']);
        expect(innermostScope(tokenWithText(lines, 'none'))).toBe(semanticScope('keyword.primitive'));
        expect(tokenWithText(lines, 'defs.svh').scopes).toContain('string.quoted.double.systemverilog');
    });

    it('uses the default scopes of the semantic token types for names', async () => {
        const lines = await tokenize(SV, [
            'module top #(parameter int W = 4) (input logic clk);',
            '  import pkg::*;',
            '  state_t st;',
            '  fifo #(.W(W)) u_fifo (.clk(clk), .rst);',
            '  initial $display("%d", f(1));',
            '  always_ff @(posedge clk) begin : blk',
            '  end : blk',
            '  function automatic logic [W-1:0] f(int a);',
            '    return C::g(a);',
            '  endfunction',
            'endmodule : top',
            'interface bus_if; endinterface',
            'package pkg; endpackage',
        ]);
        const scopeOfText = (text: string, occurrence = 0): string | undefined =>
            innermostScope(lines.flat().filter((token) => token.text === text)[occurrence]);
        expect(scopeOfText('top')).toBe('entity.name.type.class.systemverilog');
        expect(scopeOfText('top', 1)).toBe('entity.name.type.class.systemverilog');
        expect(scopeOfText('bus_if')).toBe('entity.name.type.interface.systemverilog');
        expect(scopeOfText('pkg')).toBe('entity.name.namespace.systemverilog');
        expect(scopeOfText('pkg', 1)).toBe('entity.name.namespace.systemverilog');
        expect(scopeOfText('state_t')).toBe('entity.name.type.systemverilog');
        expect(scopeOfText('fifo')).toBe('entity.name.type.class.systemverilog');
        expect(scopeOfText('$display')).toBe('support.function.systemverilog');
        expect(scopeOfText('f', 1)).toBe('entity.name.function.systemverilog');
        expect(scopeOfText('g')).toBe('entity.name.function.systemverilog');
        expect(scopeOfText('blk')).toBe('entity.name.namespace.systemverilog');
        expect(scopeOfText('blk', 1)).toBe('entity.name.namespace.systemverilog');
        for (const label of ['W', 'clk', 'rst']) {
            const labels = lines.flat().filter((token) => token.text === label && token.scopes.includes('entity.name.function.systemverilog'));
            expect(labels.length, `connection label .${label}`).toBe(1);
        }
        expect(scopeOfText('%d')).toBe('string.quoted.double.systemverilog');
        expect(scopeOfText('4')).toBe('constant.numeric.systemverilog');
    });

    it('leaves plain identifiers unscoped, as llg_ls leaves unresolved names', async () => {
        const lines = await tokenize(SV, ['assign data_out = data_in & mask;']);
        for (const name of ['data_out', 'data_in', 'mask']) {
            expect(innermostScope(tokenWithText(lines, name)), name).toBeUndefined();
        }
        expect(tokensWithScope(lines, 'keyword.operator.systemverilog').map((token) => token.text)).toEqual([
            '=',
            '&',
            ';',
        ]);
    });

    it('tokenizes numbers, attributes and comments', async () => {
        const lines = await tokenize(SV, [
            "(* keep = \"true\" *) reg [7:0] r = 8'hFF; // TODO: reset",
            "always @(*) q = '0 + 1.5e3 + 10ns; /* block",
            '   comment */ wire w;',
        ]);
        const numbers = tokensWithScope(lines, 'constant.numeric.systemverilog').map((token) => token.text);
        expect(numbers).toEqual(['7', '0', "8'hFF", "'0", '1.5e3', '10ns']);
        expect(innermostScope(tokenWithText(lines, 'keep'))).toBe('entity.other.attribute-name.systemverilog');
        // `@(*)` is an event control, not an attribute.
        expect(tokensWithScope([lines[1]], 'meta.attribute.systemverilog')).toEqual([]);
        expect(tokenWithText(lines, 'TODO').scopes).toContain('invalid.unimplemented.todo.systemverilog');
        expect(tokensWithScope(lines, 'comment.block.systemverilog').map((token: ScopedToken) => token.text).join('')).toBe(
            '/* block   comment */',
        );
        expect(innermostScope(tokenWithText(lines, 'wire'))).toBe(semanticScope('keyword.primitive'));
    });
});
