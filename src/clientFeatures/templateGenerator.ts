// SPDX-License-Identifier: MIT
import * as vscode from 'vscode';

import { ParsedModule, parseModuleDefinitions, signalDeclaration } from './verilogStructure';

export type TemplateKind =
    | 'testbench'
    | 'cocotb'
    | 'module'
    | 'interface'
    | 'clock-reset'
    | 'assertion'
    | 'covergroup';

const TEMPLATE_CHOICES: Array<vscode.QuickPickItem & { templateKind: TemplateKind }> = [
    { label: 'SystemVerilog testbench', description: 'Generate a self-contained DUT testbench', templateKind: 'testbench' },
    { label: 'cocotb test', description: 'Generate a Python cocotb starter', templateKind: 'cocotb' },
    { label: 'Module', description: 'Insert a module skeleton', templateKind: 'module' },
    { label: 'Interface', description: 'Insert an interface with modports', templateKind: 'interface' },
    { label: 'Clock and reset', description: 'Insert clock/reset generation', templateKind: 'clock-reset' },
    { label: 'Assertion property', description: 'Insert a concurrent assertion skeleton', templateKind: 'assertion' },
    { label: 'Covergroup', description: 'Insert a covergroup skeleton', templateKind: 'covergroup' },
];

function localParameterDeclaration(parameter: ParsedModule['parameters'][number]): string {
    const declaration = parameter.declaration.trim();
    if (/^localparam\b/i.test(declaration)) {
        return declaration.endsWith(';') ? declaration : `${declaration};`;
    }
    const local = /^parameter\b/i.test(declaration)
        ? declaration.replace(/^parameter\b/i, 'localparam')
        : `localparam ${declaration}`;
    return local.endsWith(';') ? local : `${local};`;
}

export function generateSystemVerilogTestbench(module: ParsedModule): string {
    const parameters = module.parameters.map((parameter) => `    ${localParameterDeclaration(parameter)}`).join('\n');
    const signals = module.ports
        .map((port) => `    ${signalDeclaration(port)}`)
        .join('\n');
    const parameterConnections = module.parameters.length === 0
        ? ''
        : ` #(
${module.parameters.map((parameter) => `        .${parameter.name}(${parameter.name})`).join(',\n')}
    )`;
    const portConnections = module.ports
        .map((port) => `        .${port.name}(${port.name})`)
        .join(',\n');
    const clockPort = module.ports.find((port) => /^(?:clk|clock|i_clk)$/i.test(port.name));
    const resetPort = module.ports.find((port) => /^(?:rst|reset|rst_n|reset_n|aresetn)$/i.test(port.name));
    const clock = clockPort
        ? `\n    initial ${clockPort.name} = 1'b0;\n    always #5 ${clockPort.name} = ~${clockPort.name};\n`
        : '';
    const reset = resetPort
        ? `\n        ${resetPort.name} = ${/_n$|n$/i.test(resetPort.name) ? "1'b0" : "1'b1"};\n        ${clockPort ? `repeat (2) @(posedge ${clockPort.name});` : '#20;'}\n        ${resetPort.name} = ${/_n$|n$/i.test(resetPort.name) ? "1'b1" : "1'b0"};`
        : '';
    const finishDelay = clockPort ? `repeat (10) @(posedge ${clockPort.name});` : '#100;';

    return `\`timescale 1ns/1ps

module ${module.name}_tb;
${parameters ? `${parameters}\n\n` : ''}${signals ? `${signals}\n` : ''}${clock}
    ${module.name}${parameterConnections} dut (
${portConnections}
    );

    initial begin${reset}

        // TODO: add stimulus and checks.
        ${finishDelay}
        $finish;
    end
endmodule
`;
}

export function generateCocotbTest(module: ParsedModule): string {
    const clockPort = module.ports.find((port) => /^(?:clk|clock|i_clk)$/i.test(port.name));
    const resetPort = module.ports.find((port) => /^(?:rst|reset|rst_n|reset_n|aresetn)$/i.test(port.name));
    const clockSetup = clockPort
        ? `    cocotb.start_soon(Clock(dut.${clockPort.name}, 10, units="ns").start())\n`
        : '';
    const resetSetup = resetPort
        ? `    dut.${resetPort.name}.value = ${/_n$|n$/i.test(resetPort.name) ? '0' : '1'}\n    await Timer(20, units="ns")\n    dut.${resetPort.name}.value = ${/_n$|n$/i.test(resetPort.name) ? '1' : '0'}\n`
        : '';
    return `import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge, Timer


@cocotb.test()
async def test_${module.name}(dut):
${clockSetup}${resetSetup}    # TODO: drive inputs and assert expected outputs.
    ${clockPort ? `await RisingEdge(dut.${clockPort.name})` : 'await Timer(1, units="ns")'}
`;
}

export function staticTemplate(kind: Exclude<TemplateKind, 'testbench' | 'cocotb'>): string {
    switch (kind) {
        case 'module':
            return 'module module_name #(\n    parameter int WIDTH = 8\n) (\n    input  logic             clk,\n    input  logic             rst_n,\n    output logic [WIDTH-1:0] data\n);\n\n    // TODO: implementation\n\nendmodule\n';
        case 'interface':
            return 'interface interface_name #(parameter int WIDTH = 8) (input logic clk);\n    logic valid;\n    logic ready;\n    logic [WIDTH-1:0] data;\n\n    modport initiator (output valid, data, input ready);\n    modport target    (input valid, data, output ready);\nendinterface\n';
        case 'clock-reset':
            return "initial clk = 1'b0;\nalways #5 clk = ~clk;\n\ninitial begin\n    rst_n = 1'b0;\n    repeat (2) @(posedge clk);\n    rst_n = 1'b1;\nend\n";
        case 'assertion':
            return 'property p_name;\n    @(posedge clk) disable iff (!rst_n)\n    antecedent |-> consequent;\nendproperty\n\na_name: assert property (p_name)\n    else $error("p_name failed");\n';
        case 'covergroup':
            return 'covergroup cg_name @(posedge clk);\n    option.per_instance = 1;\n    cp_signal: coverpoint signal;\nendgroup\n\ncg_name cg_name_inst = new();\n';
    }
}

async function chooseModule(document: vscode.TextDocument): Promise<ParsedModule | undefined> {
    const modules = parseModuleDefinitions(document.getText());
    if (modules.length === 0) {
        void vscode.window.showErrorMessage('HDL-Support: no supported module declaration found in the active document');
        return undefined;
    }
    if (modules.length === 1) {
        return modules[0];
    }
    const selected = await vscode.window.showQuickPick(modules.map((module) => module.name), {
        placeHolder: 'Choose the module for the generated template',
    });
    return modules.find((module) => module.name === selected);
}

async function openGeneratedDocument(language: string, content: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ language, content });
    await vscode.window.showTextDocument(document, { preview: false });
}

export function registerTemplateGenerator(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.commands.registerCommand('hdlsupport.templates.generate', async () => {
        const selected = await vscode.window.showQuickPick(TEMPLATE_CHOICES, {
            matchOnDescription: true,
            placeHolder: 'Choose an HDL template',
        });
        if (!selected) {
            return;
        }
        const kind = selected.templateKind;
        const editor = vscode.window.activeTextEditor;
        if (kind === 'testbench' || kind === 'cocotb') {
            if (!editor || !['verilog', 'systemverilog'].includes(editor.document.languageId)) {
                void vscode.window.showErrorMessage('HDL-Support: open a Verilog/SystemVerilog module first');
                return;
            }
            const module = await chooseModule(editor.document);
            if (!module) {
                return;
            }
            await openGeneratedDocument(
                kind === 'cocotb' ? 'python' : 'systemverilog',
                kind === 'cocotb' ? generateCocotbTest(module) : generateSystemVerilogTestbench(module),
            );
            return;
        }
        if (!editor) {
            await openGeneratedDocument('systemverilog', staticTemplate(kind));
            return;
        }
        await editor.edit((builder) => builder.replace(editor.selection, staticTemplate(kind)));
    }));
}
