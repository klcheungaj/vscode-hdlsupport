// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
    findMatchingDelimiter,
    maskComments,
    parseModuleDefinitions,
    signalDeclaration,
    splitTopLevel,
} from '../../clientFeatures/verilogStructure';

const declaration = `
module child #(
    parameter int WIDTH = 8,
    parameter bit MODE = 0
) (
    input logic clk,
    input logic [WIDTH-1:0] data,
    output logic [WIDTH-1:0] q
);
endmodule
`;

describe('client-side Verilog structure helpers', () => {
    it('parses ANSI ports and parameters while ignoring commented modules', () => {
        const modules = parseModuleDefinitions(`// module fake(input x); endmodule\n${declaration}`);

        expect(modules).toHaveLength(1);
        expect(modules[0].name).toBe('child');
        expect(modules[0].parameters.map((parameter) => parameter.name)).toEqual(['WIDTH', 'MODE']);
        expect(modules[0].ports).toEqual([
            { name: 'clk', direction: 'input', typeText: 'logic' },
            { name: 'data', direction: 'input', typeText: 'logic [WIDTH-1:0]' },
            { name: 'q', direction: 'output', typeText: 'logic [WIDTH-1:0]' },
        ]);
    });

    it('does not inherit a packed type across a new direction keyword', () => {
        const module = parseModuleDefinitions('module m(input logic [7:0] a, b, output c); endmodule')[0];

        expect(module.ports.map((port) => port.typeText)).toEqual(['logic [7:0]', 'logic [7:0]', 'logic']);
    });

    it('preserves offsets while masking comments and leaves string contents intact', () => {
        const source = 'logic a; // ignored\nstring s = "/* text */"; /* block\ncomment */ logic b;';
        const masked = maskComments(source);

        expect(masked).toHaveLength(source.length);
        expect(masked).toContain('"/* text */"');
        expect(masked.split('\n')).toHaveLength(source.split('\n').length);
        expect(masked).not.toContain('ignored');
        expect(masked).not.toContain('comment');
    });

    it('matches nested delimiters and splits only top-level connections', () => {
        const expression = '(fn(a, {b, c}), "x,y", arr[index +: 2])';

        expect(findMatchingDelimiter(expression, 0)).toBe(expression.length - 1);
        expect(findMatchingDelimiter('no delimiter', 0)).toBeUndefined();
        expect(splitTopLevel(expression.slice(1, -1))).toEqual([
            'fn(a, {b, c})',
            '"x,y"',
            'arr[index +: 2]',
        ]);
    });

    it('supports lifetime-qualified, no-port, and non-ANSI module declarations', () => {
        const modules = parseModuleDefinitions(`
module automatic empty; endmodule
module legacy(clk, q);
    input wire clk;
    output reg [3:0] q;
endmodule
`);

        expect(modules.map((candidate) => candidate.name)).toEqual(['empty', 'legacy']);
        expect(modules[0].ports).toEqual([]);
        expect(modules[1].ports).toEqual([
            { name: 'clk', direction: 'input', typeText: 'wire' },
            { name: 'q', direction: 'output', typeText: 'reg [3:0]' },
        ]);
    });

    it('rejects unsupported interface-style headers instead of returning incomplete port metadata', () => {
        expect(parseModuleDefinitions('module m(bus_if.target bus); endmodule')).toEqual([]);
        expect(parseModuleDefinitions('module incomplete(input logic a);')).toEqual([]);
    });

    it('renders a signal declaration for a port', () => {
        const module = parseModuleDefinitions(declaration)[0];
        expect(signalDeclaration(module.ports[1], 'payload')).toBe('logic [WIDTH-1:0] payload;');
    });
});
