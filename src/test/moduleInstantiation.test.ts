// SPDX-License-Identifier: MIT
//
// Pure unit tests for the module-instantiation helpers. The fixtures mirror
// the REAL document-symbol output of the llg language server:
//   - lapligence/src/bin/llg_ls/features.rs sym_kind_to_lsp (lines 2417-2433) maps
//     Port -> Property (7), Net|Var -> Variable (13), Param -> Constant (14)
//     and Module/Program -> Module (2).
//   - features.rs module_children (lines 2617-2637) emits exactly those
//     Port/Net/Var/Param entries as module children (fallback at 2662-2686
//     uses the same three kinds).
//   - features.rs format_param/format_port (lines 2129-2162) produce detail
//     strings like "parameter int WIDTH = 8" / "input logic clk".
//   - features.rs unit test document_symbols_contain_module_with_port_child
//     (lines 3584-3601) asserts a Module-kind symbol "m" with Property-kind
//     port child "clk".

import { describe, expect, it } from 'vitest';
import {
    buildInstantiationSnippet,
    classifyModuleChildren,
    DestinationSnapshot,
    planInsertion,
    PortOrParam,
} from '../commands/ModuleInstantiation';

describe('classifyModuleChildren', () => {
    it('splits a real llg module symbol into parameters and ports', () => {
        // Children of: module counter #(parameter int WIDTH = 8,
        //              localparam int DEPTH = 4)(input logic clk,
        //              input logic rst_n, output logic [WIDTH-1:0] q);
        const children = [
            { name: 'WIDTH', kind: 14, detail: 'parameter int WIDTH = 8' },
            { name: 'DEPTH', kind: 14, detail: 'localparam int DEPTH = 4' },
            { name: 'clk', kind: 7, detail: 'input logic clk' },
            { name: 'rst_n', kind: 7, detail: 'input logic rst_n' },
            { name: 'q', kind: 7, detail: 'output logic [WIDTH-1:0] q' },
        ];

        expect(classifyModuleChildren(children)).toEqual([
            { name: 'WIDTH', detail: 'parameter int WIDTH = 8', isParameter: true },
            { name: 'DEPTH', detail: 'localparam int DEPTH = 4', isParameter: true },
            { name: 'clk', detail: 'input logic clk', isParameter: false },
            { name: 'rst_n', detail: 'input logic rst_n', isParameter: false },
            { name: 'q', detail: 'output logic [WIDTH-1:0] q', isParameter: false },
        ]);
    });

    it('treats nets/variables as ports', () => {
        // llg emits plain nets/variables inside modules as Variable (13),
        // never as parameters.
        const children = [{ name: 'bus', kind: 13, detail: 'logic [7:0] bus' }];
        expect(classifyModuleChildren(children)).toEqual([
            { name: 'bus', detail: 'logic [7:0] bus', isParameter: false },
        ]);
    });

    it('defaults unknown kinds to ports', () => {
        const children = [
            { name: 'mystery', kind: 999 },
            // TypeParameter (26) is what llg emits for typedefs
            // (features.rs sym_kind_to_lsp), which are not parameters.
            { name: 'my_type', kind: 26, detail: 'typedef enum {A, B} my_type' },
        ];
        expect(classifyModuleChildren(children)).toEqual([
            { name: 'mystery', detail: undefined, isParameter: false },
            { name: 'my_type', detail: 'typedef enum {A, B} my_type', isParameter: false },
        ]);
    });

    it('recognizes parameters by their detail text regardless of kind', () => {
        const children = [
            { name: 'X', kind: 13, detail: 'parameter int X = 1' },
            { name: 'Y', kind: 14 },
        ];
        const classified = classifyModuleChildren(children);
        expect(classified.map((c) => c.isParameter)).toEqual([true, true]);
    });

    it('skips Object-kind instance children instead of listing them as ports', () => {
        // llg document symbols carry one Object (19) leaf per instantiation
        // site whose detail is the instantiated module type; instances must
        // never become .name(name) connection lines in generated snippets.
        const children = [
            { name: 'clk', kind: 7, detail: 'input logic' },
            { name: 'u_dut', kind: 19, detail: 'child_mod' },
            { name: 'u_pipe', kind: 19, detail: 'counter #(.WIDTH(4))' },
        ];
        expect(classifyModuleChildren(children)).toEqual([
            { name: 'clk', detail: 'input logic', isParameter: false },
        ]);
    });

    it('returns an empty list for empty children', () => {
        expect(classifyModuleChildren([])).toEqual([]);
    });

    it('keeps declaration order intact', () => {
        const children = [
            { name: 'b_port', kind: 7 },
            { name: 'a_param', kind: 14 },
            { name: 'a_port', kind: 7 },
        ];
        const names = classifyModuleChildren(children).map((p: PortOrParam) => p.name);
        expect(names).toEqual(['b_port', 'a_param', 'a_port']);
    });
});

describe('buildInstantiationSnippet', () => {
    // Expectations are written as explicit concatenations mirroring the
    // generator 1:1: note that tabstop $2 carries the opening parenthesis and
    // newline INSIDE the placeholder ("${2:(" + "\n" + "}"), so the "}"
    // precedes the first port line rather than trailing the "(" line.
    it('renders two parameters and three ports exactly like the legacy generator', () => {
        const portsAndParams = classifyModuleChildren([
            { name: 'WIDTH', kind: 14, detail: 'parameter int WIDTH = 8' },
            { name: 'DEPTH', kind: 14, detail: 'localparam int DEPTH = 4' },
            { name: 'clk', kind: 7, detail: 'input logic clk' },
            { name: 'rst_n', kind: 7, detail: 'input logic rst_n' },
            { name: 'data', kind: 7, detail: 'output logic [WIDTH-1:0] data' },
        ]);

        const expected =
            'counter ' +
            '#(\n' +
            '    .WIDTH (WIDTH ),\n' +
            '    .DEPTH (DEPTH )\n' +
            ')\n' +
            '${1:u_counter}' +
            '${2:(\n}' +
            '    .clk   (clk   ),\n' +
            '    .rst_n (rst_n ),\n' +
            '    .data  (data  )\n' +
            ');\n';

        expect(buildInstantiationSnippet('counter', 'u_counter', portsAndParams)).toBe(expected);
    });

    it('omits the parameter block when there are no parameters', () => {
        const expected =
            'counter ' +
            '${1:u_counter}' +
            '${2:(\n}' +
            '    .clk   (clk   ),\n' +
            '    .rst_n (rst_n ),\n' +
            '    .data  (data  )\n' +
            ');\n';

        expect(buildInstantiationSnippet('counter', 'u_counter', [
            { name: 'clk', detail: 'input logic clk', isParameter: false },
            { name: 'rst_n', detail: 'input logic rst_n', isParameter: false },
            { name: 'data', detail: 'output logic', isParameter: false },
        ])).toBe(expected);
    });

    it('renders an empty connection block when there are no ports', () => {
        expect(buildInstantiationSnippet('fifo', 'u_fifo', [
            { name: 'DEPTH', detail: 'parameter int DEPTH = 4', isParameter: true },
        ])).toBe(
            'fifo ' +
            '#(\n' +
            '    .DEPTH (DEPTH )\n' +
            ')\n' +
            '${1:u_fifo}' +
            '${2:(\n}' +
            ');\n'
        );
    });

    it('uses the provided instance name without concatenating the module name', () => {
        expect(buildInstantiationSnippet('bar', 'foo', [])).toBe(
            'bar ' +
            '${1:foo}' +
            '${2:(\n}' +
            ');\n'
        );
    });

    it('handles long module, instance, and port names', () => {
        const moduleName = 'some_very_long_module_name_for_testing';
        const instanceName = 'u_some_very_long_module_name_for_testing';
        const portName = 'very_long_port_name_exceeding_typical_width';

        const expected =
            moduleName + ' ' +
            '${1:' + instanceName + '}' +
            '${2:(\n}' +
            '    .' + portName + ' (' + portName + ' )\n' +
            ');\n';

        expect(buildInstantiationSnippet(moduleName, instanceName, [
            { name: portName, detail: 'input logic', isParameter: false },
        ])).toBe(expected);
    });
});

describe('planInsertion (destination capture)', () => {
    function destinationSnapshot(uri: string, line: number, character: number): DestinationSnapshot {
        return {
            uri,
            version: 7,
            anchor: { line, character },
            active: { line, character },
        };
    }

    // Regression mirror of the reported bug: the user edits top_tb.sv (file C,
    // the captured destination) and picks module `counter`, whose definition
    // lives in counter.sv (file B). Loading B's symbols opens B and - in the
    // old flow - even focused it before the insertion target was resolved.
    // planInsertion must still target C at its frozen cursor because its only
    // inputs are the pre-capture snapshot plus an observation of C itself:
    // the signature has NO slot through which a later active editor could leak.
    it('regression: picking a module defined in B while editing C still plans the insertion into C', () => {
        const editingC = destinationSnapshot('file:///proj/tb/top_tb.sv', 12, 4);
        const observedAfterBWasOpenedAndFocused = { editorVisible: true, documentOpen: true };

        expect(planInsertion(editingC, observedAfterBWasOpenedAndFocused)).toEqual({
            outcome: 'insert',
            uri: 'file:///proj/tb/top_tb.sv',
            anchor: { line: 12, character: 4 },
            active: { line: 12, character: 4 },
        });
        expect(editingC.uri).not.toBe('file:///proj/rtl/counter.sv');
    });

    it('freezes anchor and cursor captured before module loading started', () => {
        const snapshot: DestinationSnapshot = {
            uri: 'file:///proj/rtl/top.sv',
            version: 41,
            anchor: { line: 3, character: 16 },
            active: { line: 9, character: 0 },
        };

        expect(planInsertion(snapshot, { editorVisible: true, documentOpen: true })).toEqual({
            outcome: 'insert',
            uri: 'file:///proj/rtl/top.sv',
            anchor: { line: 3, character: 16 },
            active: { line: 9, character: 0 },
        });
    });

    it('carries the captured cursor regardless of later document activity (version bumps included)', () => {
        // Even if the user typed meanwhile (bumping version beyond the
        // captured one), the insertion point stays the captured one: the plan
        // carries no live editor state at all.
        const snapshot = destinationSnapshot('file:///proj/rtl/top.sv', 5, 2);

        const plan = planInsertion(snapshot, { editorVisible: true, documentOpen: true });
        expect(plan.outcome).toBe('insert');
        expect(plan.outcome === 'insert' && plan.active).toEqual({ line: 5, character: 2 });
    });

    it('fails gracefully when the captured editor and document were closed meanwhile', () => {
        const snapshot = destinationSnapshot('file:///proj/tb/top_tb.sv', 0, 0);

        expect(planInsertion(snapshot, { editorVisible: false, documentOpen: false })).toEqual({
            outcome: 'destinationClosed',
            uri: 'file:///proj/tb/top_tb.sv',
        });
    });

    it('does not insert into a lingering hidden buffer whose editor was closed', () => {
        const snapshot = destinationSnapshot('file:///proj/tb/top_tb.sv', 0, 0);

        expect(
            planInsertion(snapshot, { editorVisible: false, documentOpen: true }).outcome
        ).toBe('destinationClosed');
    });

    it('treats a missing observation as a closed destination', () => {
        const snapshot = destinationSnapshot('file:///proj/tb/top_tb.sv', 0, 0);

        expect(planInsertion(snapshot, undefined).outcome).toBe('destinationClosed');
    });
});
