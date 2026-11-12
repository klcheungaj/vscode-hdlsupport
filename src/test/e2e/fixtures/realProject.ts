import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

export { computeTreeChecksum, positionAt } from './workspace';

let fixtureCounter = 0;

export interface RealProjectOptions {
    /**
     * Inject a Slang-visible frontend error into an unrelated module file
     * so the whole-project analysis is NOT clean, mirroring real repositories.
     * Default true. The semantic-tokens conformance suite uses false so it
     * validates wire format over a fully clean project.
     */
    injectError?: boolean;
    /**
     * Add `[compile].top` to this temporary fixture's config. The config is
     * written below the OS temp directory and is never a tracked project
     * file, so top-selection coverage stays read-only.
     */
    compileTop?: string;
    /** Write the foo.v comment-leak reproduction into this temporary project. */
    includeFooRepro?: boolean;
}

export interface RealProjectFixture {
    /** Temporary base directory (unique per call). */
    readonly baseDir: string;
    /** The workspace root handed to the server: `<baseDir>/proj`. */
    readonly projectDir: string;
    readonly configPath: string;
    readonly rtlDir: string;
    readonly topPath: string;
    readonly ddrCtrlPath: string;
    readonly typeShapesPath: string;
    readonly deepModPath: string;
    readonly tbTopPath: string;
    readonly defsVhPath: string;
    /** Path reserved for the optional foo.v reproduction. */
    readonly fooPath: string;
    readonly projectUri: string;
    readonly topUri: string;
    readonly ddrCtrlUri: string;
    readonly typeShapesUri: string;
    readonly deepModUri: string;
    readonly tbTopUri: string;
    readonly defsVhUri: string;
    readonly fooUri: string;
    /** Recursive content checksum captured right after creation. */
    checksum: string;
    /** Removes the whole tree; safe to call twice. */
    dispose(): void;
}

/** v1 schema, production shape: recursive discovery from the root plus an
 *  explicit include directory (defaults apply only when the whole file is
 *  missing, so partial tables must be complete — see fixtures/workspace.ts). */
export const LLG_TOML_TEXT = [
    'schema_version = 1',
    '',
    '[sources]',
    'directories = ["."]',
    'include = ["**/*.v", "**/*.sv"]',
    '',
    '[compile]',
    'include_dirs = ["include"]',
    '',
].join('\n');

function llgTomlText(compileTop?: string): string {
    if (compileTop === undefined) {
        return LLG_TOML_TEXT;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(compileTop)) {
        throw new Error(`invalid compile.top fixture value: ${JSON.stringify(compileTop)}`);
    }
    return LLG_TOML_TEXT.replace('[compile]\n', `[compile]\ntop = "${compileTop}"\n`);
}

export const DEFS_VH_TEXT = [
    '// Shared project macros, reached through `include plus [compile] include_dirs.',
    '`ifndef LLG_PROJ_DEFS_VH',
    '`define LLG_PROJ_DEFS_VH',
    '',
    '`define DATA_W 8',
    '`define ADDR_W 12',
    '',
    '`endif',
    '',
].join('\n');

/** Opened by the user in the parity suite. Spaces mostly, TAB indentation on
 *  some lines, macro references, and a nested instantiation of ddr_ctrl. */
export const TOP_SV_TEXT = [
    '`include "defs.vh"',
    '',
    'module top (',
    '    input  logic               clk,',
    '    input  logic               rst_n,',
    '    input  logic [`DATA_W-1:0] bus_wdata,',
    '    input  logic               bus_wr,',
    '    output logic [`DATA_W-1:0] bus_rdata,',
    '    output logic               bus_ready',
    ');',
    '',
    '\tlogic [`DATA_W-1:0] ddr_rdata;',
    '\tlogic               ddr_ready;',
    '\tlogic [15:0]        ddr_rdata_wide;',
    '\tlogic               ddr_ready_wide;',
    '',
    '    ddr_ctrl #(',
    '        .DATA_W (`DATA_W),',
    '        .ADDR_W (`ADDR_W)',
    '    ) u_ddr_ctrl (',
    '        .clk   (clk),',
    '        .rst_n (rst_n),',
    '        .wr_en ({bus_wr, bus_wr}),',
    '        .wdata (bus_wdata),',
    '        .rdata (ddr_rdata),',
    '        .ready (ddr_ready)',
    '    );',
    '',
    '    ddr_ctrl #(',
    '        .DATA_W (16),',
    '        .ADDR_W (10),',
    '        .LANES  (2)',
    '    ) u_ddr_ctrl_wide (',
    '        .clk   (clk),',
    '        .rst_n (rst_n),',
    '        .wr_en ({bus_wr, bus_wr}),',
    '        .wdata ({bus_wdata, bus_wdata}),',
    '        .rdata (ddr_rdata_wide),',
    '        .ready (ddr_ready_wide)',
    '    );',
    '',
    '    type_shapes #(',
    '        .WIDTH (8),',
    '        .DEPTH (4)',
    '    ) u_type_shapes_default ();',
    '',
    '    type_shapes #(',
    '        .WIDTH (16),',
    '        .DEPTH (2)',
    '    ) u_type_shapes_wide ();',
    '',
    '\tassign bus_rdata = ddr_rdata; // TAB-indented on purpose',
    '\tassign bus_ready = ddr_ready; // TAB-indented on purpose',
    '',
    'endmodule',
    '',
].join('\n');

/** Never opened by the parity suite; opened first by the conformance suite.
 *  Clean module with parameters, ports, TAB indentation and one >120-col line. */
export const DDR_CTRL_SV_TEXT = [
    '`include "defs.vh"',
    '',
    'module ddr_ctrl #(',
    '\tparameter int DATA_W = `DATA_W,',
    '\tparameter int ADDR_W = `ADDR_W,',
    '\tparameter int LANES  = 4',
    ') (',
    '\tinput  logic              clk,',
    '\tinput  logic              rst_n,',
    '\tinput  logic [LANES-1:0]  wr_en,',
    '\tinput  logic [DATA_W-1:0] wdata,',
    '\toutput logic [DATA_W-1:0] rdata,',
    '\toutput logic              ready',
    ');',
    '',
    '\tlogic [ADDR_W-1:0] addr_q;',
    '\tlogic              busy_q;',
    '',
    '\talways_ff @(posedge clk or negedge rst_n) begin',
    '\t\tif (!rst_n) begin',
    '\t\t\taddr_q <= \'0;',
    '\t\t\tbusy_q <= 1\'b0;',
    '\t\tend else begin',
    '\t\t\tbusy_q <= |wr_en;',
    '\t\tend',
    '\tend',
    '',
    '\tassign rdata = wdata;',
    '',
    '\tassign ready = (busy_q !== 1\'bx) && ((|wr_en) || (!(|wr_en))) && (addr_q === addr_q) && (DATA_W + ADDR_W + LANES > 0); // deliberately wide line beyond 120 columns',
    '',
    'endmodule',
    '',
].join('\n');

/** Type-shape fixture for the module explorer contract.  It deliberately
 * mixes concrete packed dimensions, a multiline packed+unpacked declaration,
 * a scalar typedef, and a scalar net qualifier. */
export const TYPE_SHAPES_SV_TEXT = [
    'typedef enum logic { ALIAS_ZERO, ALIAS_ONE } scalar_alias_t;',
    '',
    'module type_shapes #(',
    '    parameter int WIDTH = 8,',
    '    parameter int DEPTH = 4',
    ') (',
    '    input  logic [1:0][WIDTH-1:0] packed_bus,',
    '    output logic [WIDTH-1:0]',
    '        unpacked_bus [0:3],',
    '    input  scalar_alias_t named_port,',
    '    input  wire scalar_wire_port',
    ');',
    '',
    '    logic [1:0][WIDTH-1:0] packed_signal;',
    '    logic [WIDTH-1:0]',
    '        unpacked_signal [0:3];',
    '    scalar_alias_t named_signal;',
    '    wire scalar_wire_signal;',
    '    // This is a line comment immediately before a plain wire declaration.',
    '    wire start;',
    'endmodule',
    '',
    '// Kept uninstantiated so the source-graph declaration payload remains',
    '// observable alongside the elaborated instances above.',
    'module type_shapes_decl_only (',
    '    input  scalar_alias_t named_port,',
    '    input  wire scalar_wire_port',
    ');',
    '    scalar_alias_t named_signal;',
    '    wire scalar_wire_signal;',
    'endmodule',
    '',
].join('\n');

/** Nested-directory module, clean variant (used when injectError=false). */
export const DEEP_MOD_CLEAN_SV_TEXT = [
    '// Module discovered only through recursive source-directory scanning',
    '// (rtl/sub/deep_mod.sv).',
    'module deep_mod (',
    '    input  logic clk,',
    '    input  logic d,',
    '    output logic q',
    ');',
    '    assign q = d;',
    'endmodule',
    '',
].join('\n');

/** Deliberate Slang frontend error (used when injectError=true): the include
 *  target exists nowhere in the project, matching a common incomplete-project
 *  failure while the server keeps its declaration-level feature snapshot. */
export const DEEP_MOD_ERROR_SV_TEXT = [
    '// Module discovered only through recursive source-directory scanning',
    '// (rtl/sub/deep_mod.sv).',
    '// DELIBERATE ERROR below: the include target does not exist anywhere in',
    '// the project, so Surelog reports a preprocessor Error (not Syntax) and',
    '// whole-project analysis mirrors a real repository with compile errors.',
    '`include "missing_project_defs.svh"',
    '',
    'module deep_mod (',
    '    input  logic clk,',
    '    input  logic d,',
    '    output logic q',
    ');',
    '    assign q = d;',
    'endmodule',
    '',
].join('\n');

/** Testbench written with CRLF line endings and TAB indentation (one of the
 *  production wrinkles under test); instantiates top with a subset of named
 *  connections, which is legal SystemVerilog. */
export const TB_TOP_SV_TEXT = [
    '`timescale 1ns/1ps',
    '',
    'module tb_top;',
    '',
    '\tlogic clk;',
    '\tlogic rst_n;',
    '',
    '\tinitial begin',
    '\t\tclk = 1\'b0;',
    '\t\tforever #5 clk = ~clk;',
    '\tend',
    '',
    '\ttop u_top (',
    '\t\t.clk   (clk),',
    '\t\t.rst_n (rst_n)',
    '\t);',
    '',
    'endmodule',
    '',
].join('\r\n');

/** A line comment directly above a plain wire declaration; regression input
 *  for comments leaking into Module Contents type displays. */
export const FOO_V_TEXT = [
    'module Foo();',
    '',
    '// This ia a line comment',
    'wire start;',
    '',
    'endmodule',
    '',
].join('\n');

/**
 * Builds a fresh read-only fixture workspace under os.tmpdir() shaped like a
 * real repository:
 *
 *   <base>/proj/llg.toml
 *   <base>/proj/rtl/top.sv         instantiates ddr_ctrl; TAB lines; macros
 *   <base>/proj/rtl/ddr_ctrl.sv    clean module with params/ports; >120-col line
 *   <base>/proj/rtl/type_shapes.sv packed/unpacked, typedef and net fixtures
 *   <base>/proj/rtl/sub/deep_mod.sv nested dir; carries the DELIBERATE
 *                                  missing-include Error unless
 *                                  options.injectError === false
 *   <base>/proj/tb/tb_top.sv       CRLF endings; instantiates top
 *   <base>/proj/include/defs.vh    macro header via include_dirs
 *   <base>/proj/foo.v              optional comment-leak reproduction
 *
 * Directories are named `<prefix>-<pid>-<counter>-<rand>` so concurrent test
 * processes never collide.
 */
export function createRealProjectFixture(options: RealProjectOptions = {}, prefix = 'hdlsupport-e2e-real'): RealProjectFixture {
    const injectError = options.injectError ?? true;

    // Deterministic self-checks: the wrinkles these suites exercise must not
    // silently regress while editing the literals above.
    enforceFixtureInvariants();

    fixtureCounter += 1;
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${process.pid}-${fixtureCounter}-`));
    const projectDir = path.join(baseDir, 'proj');
    const rtlDir = path.join(projectDir, 'rtl');
    const subDir = path.join(rtlDir, 'sub');
    const tbDir = path.join(projectDir, 'tb');
    const includeDir = path.join(projectDir, 'include');
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(tbDir, { recursive: true });
    fs.mkdirSync(includeDir, { recursive: true });

    const configPath = path.join(projectDir, 'llg.toml');
    const topPath = path.join(rtlDir, 'top.sv');
    const ddrCtrlPath = path.join(rtlDir, 'ddr_ctrl.sv');
    const typeShapesPath = path.join(rtlDir, 'type_shapes.sv');
    const deepModPath = path.join(subDir, 'deep_mod.sv');
    const tbTopPath = path.join(tbDir, 'tb_top.sv');
    const defsVhPath = path.join(includeDir, 'defs.vh');
    const fooPath = path.join(projectDir, 'foo.v');

    fs.writeFileSync(configPath, llgTomlText(options.compileTop));
    fs.writeFileSync(defsVhPath, DEFS_VH_TEXT);
    fs.writeFileSync(topPath, TOP_SV_TEXT);
    fs.writeFileSync(ddrCtrlPath, DDR_CTRL_SV_TEXT);
    fs.writeFileSync(typeShapesPath, TYPE_SHAPES_SV_TEXT);
    fs.writeFileSync(deepModPath, injectError ? DEEP_MOD_ERROR_SV_TEXT : DEEP_MOD_CLEAN_SV_TEXT);
    fs.writeFileSync(tbTopPath, TB_TOP_SV_TEXT);
    if (options.includeFooRepro) {
        fs.writeFileSync(fooPath, FOO_V_TEXT);
    }

    let disposed = false;
    return {
        baseDir,
        projectDir,
        configPath,
        rtlDir,
        topPath,
        ddrCtrlPath,
        typeShapesPath,
        deepModPath,
        tbTopPath,
        defsVhPath,
        fooPath,
        projectUri: fileUri(projectDir),
        topUri: fileUri(topPath),
        ddrCtrlUri: fileUri(ddrCtrlPath),
        typeShapesUri: fileUri(typeShapesPath),
        deepModUri: fileUri(deepModPath),
        tbTopUri: fileUri(tbTopPath),
        defsVhUri: fileUri(defsVhPath),
        fooUri: fileUri(fooPath),
        checksum: computeTreeChecksumLocal(projectDir),
        dispose(): void {
            if (!disposed) {
                disposed = true;
                fs.rmSync(baseDir, { recursive: true, force: true });
            }
        },
    };
}

function fileUri(p: string): string {
    return pathToFileURL(p).href;
}

function computeTreeChecksumLocal(rootDir: string): string {
    const entries: Array<{ relative: string; hash: string }> = [];
    walk(rootDir, '');
    entries.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
    const combined = crypto.createHash('sha256');
    for (const entry of entries) {
        combined.update(`${entry.relative}\0${entry.hash}\n`);
    }
    return combined.digest('hex');

    function walk(dir: string, prefix: string): void {
        for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const absolute = path.join(dir, item.name);
            const relative = prefix === '' ? item.name : `${prefix}/${item.name}`;
            if (item.isDirectory()) {
                walk(absolute, relative);
            } else if (item.isFile()) {
                entries.push({ relative, hash: sha256File(absolute) });
            }
        }
    }
}

function sha256File(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hasLineLongerThan(text: string, columns: number): boolean {
    return text.split('\n').some((line) => line.length > columns);
}

function isCrlfOnly(text: string): boolean {
    if (!text.includes('\r\n')) {
        return false;
    }
    return text.replace(/\r\n/g, '').indexOf('\n') < 0 && text.replace(/\r\n/g, '').indexOf('\r') < 0;
}

function enforceFixtureInvariants(): void {
    if (![TOP_SV_TEXT, DDR_CTRL_SV_TEXT].some((text) => hasLineLongerThan(text, 120))) {
        throw new Error('realProject fixture invariant broken: no line longer than 120 columns');
    }
    for (const [name, text] of [['top.sv', TOP_SV_TEXT], ['ddr_ctrl.sv', DDR_CTRL_SV_TEXT], ['tb_top.sv', TB_TOP_SV_TEXT]] as const) {
        if (!text.includes('\t')) {
            throw new Error(`realProject fixture invariant broken: ${name} lost its TAB indentation`);
        }
    }
    if (!isCrlfOnly(TB_TOP_SV_TEXT)) {
        throw new Error('realProject fixture invariant broken: tb_top.sv must be CRLF-only');
    }
    if ([TOP_SV_TEXT, DDR_CTRL_SV_TEXT, DEEP_MOD_CLEAN_SV_TEXT].some((text) => text.includes('\r'))) {
        throw new Error('realProject fixture invariant broken: only tb_top.sv may carry CRLF endings');
    }
    if (
        !DEEP_MOD_ERROR_SV_TEXT.includes('module deep_mod')
        || !/^\s*endmodule\b/m.test(DEEP_MOD_ERROR_SV_TEXT)
        || !DEEP_MOD_ERROR_SV_TEXT.includes('`include "missing_project_defs.svh"')
    ) {
        throw new Error(
            'realProject fixture invariant broken: error variant must be a terminated module tainted by the missing-include Error',
        );
    }
}
