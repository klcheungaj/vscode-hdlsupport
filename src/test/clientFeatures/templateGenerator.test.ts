// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { generateCocotbTest, generateSystemVerilogTestbench, staticTemplate } from '../../clientFeatures/templateGenerator';
import { parseModuleDefinitions } from '../../clientFeatures/verilogStructure';

const module = parseModuleDefinitions(`
module counter #(parameter int WIDTH = 8) (
    input logic clk,
    input logic rst_n,
    output logic [WIDTH-1:0] count
);
endmodule
`)[0];

describe('template generation', () => {
    it('generates a connected SystemVerilog testbench with clock and reset', () => {
        const generated = generateSystemVerilogTestbench(module);

        expect(generated).toContain('module counter_tb;');
        expect(generated).toContain('.WIDTH(WIDTH)');
        expect(generated).toContain('localparam int WIDTH = 8;');
        expect(generated).toContain('.count(count)');
        expect(generated).toContain("always #5 clk = ~clk;");
        expect(generated).toContain("rst_n = 1'b0;");
    });

    it('generates a cocotb starter for the selected DUT', () => {
        const generated = generateCocotbTest(module);

        expect(generated).toContain('async def test_counter(dut):');
        expect(generated).toContain('Clock(dut.clk, 10');
        expect(generated).toContain('dut.rst_n.value = 0');
    });

    it('provides reusable SystemVerilog skeletons', () => {
        expect(staticTemplate('interface')).toContain('modport initiator');
        expect(staticTemplate('assertion')).toContain('assert property');
        expect(staticTemplate('covergroup')).toContain('covergroup cg_name');
    });

    it('uses delays instead of referencing a nonexistent clock', () => {
        const clockless = parseModuleDefinitions('module event_sink(input logic rst_n); endmodule')[0];
        const generated = generateSystemVerilogTestbench(clockless);

        expect(generated).toContain('#20;');
        expect(generated).toContain('#100;');
        expect(generated).not.toContain('@(posedge clk)');
    });

    it('generates valid empty connection lists for a no-port module', () => {
        const noPorts = parseModuleDefinitions('module empty; endmodule')[0];
        const generated = generateSystemVerilogTestbench(noPorts);

        expect(generated).toContain('empty dut (\n\n    );');
        expect(generated).toContain('#100;');
    });

    it('uses a net for an inout DUT connection', () => {
        const bidirectional = parseModuleDefinitions('module pad(inout logic [3:0] pins); endmodule')[0];

        expect(generateSystemVerilogTestbench(bidirectional)).toContain('wire [3:0] pins;');
    });

    it('preserves parameter defaults and types in generated local parameters', () => {
        const typed = parseModuleDefinitions('module typed #(parameter type T = logic, parameter int N = 3)(); endmodule')[0];
        const generated = generateSystemVerilogTestbench(typed);

        expect(generated).toContain('localparam type T = logic;');
        expect(generated).toContain('localparam int N = 3;');
    });
});
