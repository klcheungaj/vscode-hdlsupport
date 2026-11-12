import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

let fixtureCounter = 0;

export interface ShadowingFixture {
    /** Temporary base directory (unique per call); the server CWD. */
    readonly baseDir: string;
    /** The workspace root handed to the server: `<baseDir>/ws`. */
    readonly projectDir: string;
    readonly configPath: string;
    readonly blkPath: string;
    readonly funcPath: string;
    readonly taskPath: string;
    readonly genPath: string;
    readonly twoPath: string;
    readonly leafPath: string;
    readonly tbNestedPath: string;
    readonly crossLeafPath: string;
    readonly tbCrossPath: string;
    readonly editBasePath: string;
    readonly blkUri: string;
    readonly funcUri: string;
    readonly taskUri: string;
    readonly genUri: string;
    readonly twoUri: string;
    readonly leafUri: string;
    readonly tbNestedUri: string;
    readonly crossLeafUri: string;
    readonly tbCrossUri: string;
    readonly editBaseUri: string;
    /** Removes the whole tree; safe to call twice. */
    dispose(): void;
}

/** Outer `[7:0] val` vs block-local `[3:0] val`; one use inside the named
 *  block and one at module level. */
export const BLK_SV_TEXT = [
    'module shadow_blk;',
    '  logic [7:0] val;',
    '  logic en;',
    '',
    '  always_comb begin : blk',
    '    logic [3:0] val;',
    "    val = en ? 4'h1 : 4'h0;",
    '  end',
    '',
    "  assign val = 8'h00;",
    'endmodule',
    '',
].join('\n');

/** Function-local `[3:0] dat` shadows the module-level `[7:0] dat`; the
 *  call-site argument must keep using the module-level signal. */
export const FUNC_SV_TEXT = [
    'module shadow_func;',
    '  logic [7:0] dat;',
    '  logic [7:0] out;',
    '',
    '  function automatic logic [3:0] f_sh(input logic [1:0] sel);',
    '    logic [3:0] dat;',
    "    dat = {2'b00, sel};",
    '    return dat;',
    '  endfunction',
    '',
    "  assign out = {4'h0, f_sh(dat[1:0])};",
    'endmodule',
    '',
].join('\n');

/** Task-local `[15:0] cap` shadows the module-level `[7:0] cap`. */
export const TASK_SV_TEXT = [
    'module shadow_task;',
    '  logic [7:0] cap;',
    '  logic go;',
    '',
    '  task automatic t_sh(input logic [3:0] arg);',
    '    logic [15:0] cap;',
    "    cap = {12'h0, arg};",
    '  endtask',
    '',
    '  initial begin',
    "    t_sh(go ? 4'h1 : 4'h0);",
    "    cap = 8'h00;",
    '  end',
    'endmodule',
    '',
].join('\n');

/** Generate-block-local `[3:0] val` shadows the module-level `[7:0] val`;
 *  uses before AND after the generate stay on the outer declaration. */
export const GEN_SV_TEXT = [
    'module shadow_gen;',
    '  logic [7:0] val;',
    '  logic [7:0] pre;',
    '  logic [7:0] post;',
    '',
    '  assign pre = val;',
    '',
    '  genvar g;',
    '  generate',
    '    for (g = 0; g < 2; g = g + 1) begin : gen_blk',
    '      logic [3:0] val;',
    "      assign val = 4'h0;",
    '    end',
    '  endgenerate',
    '',
    '  assign post = val;',
    'endmodule',
    '',
].join('\n');

/** Two-level nesting: module `[15:0] sig` ← outer_blk `[7:0] sig` ← inner_blk
 *  `[3:0] sig`.  Each use site belongs to its own level. */
export const TWO_SV_TEXT = [
    'module shadow_two;',
    '  logic [15:0] sig;',
    '  logic en;',
    '',
    '  always_comb begin : outer_blk',
    '    logic [7:0] sig;',
    '    begin : inner_blk',
    '      logic [3:0] sig;',
    "      sig = {3'b000, en};",
    '    end',
    "    sig = en ? 8'h01 : 8'h00;",
    '  end',
    '',
    "  assign sig = 16'h0000;",
    'endmodule',
    '',
].join('\n');

export const LEAF_SV_TEXT = [
    'module leaf(input logic mode, output logic q);',
    '  assign q = mode;',
    'endmodule',
    '',
].join('\n');

/** tb and its child instance declare the SAME net name (`mode`): each side
 *  must navigate inside its own instance namespace.  The tb also shadows
 *  `mode` inside a named block. */
export const TB_NESTED_SV_TEXT = [
    'module tb_nested;',
    '  logic mode;',
    '  logic q;',
    '',
    '  leaf u0(.mode(mode), .q(q));',
    '',
    '  always_comb begin : blk',
    '    logic [3:0] mode;',
    "    mode = 1'b0;",
    '  end',
    '',
    "  assign mode = 1'b1;",
    'endmodule',
    '',
].join('\n');

export const CROSS_LEAF_SV_TEXT = [
    'module cross_leaf(input logic sel, output logic y);',
    '  assign y = sel;',
    'endmodule',
    '',
].join('\n');

/** Cross-file variant: `sel` is declared in this file AND in cross_leaf.sv's
 *  port list; the block-local `sel` shadows only the local one. */
export const TB_CROSS_SV_TEXT = [
    'module tb_cross;',
    '  logic sel;',
    '  logic y;',
    '',
    '  cross_leaf u0(.sel(sel), .y(y));',
    '',
    '  always_comb begin : blk',
    '    logic [3:0] sel;',
    "    sel = 1'b0;",
    '  end',
    '',
    "  assign sel = 1'b1;",
    'endmodule',
    '',
].join('\n');

/** On-disk baseline WITHOUT the inner block; tests open an edited buffer that
 *  adds `logic [3:0] val;` inside the named block. */
export const EDIT_BASE_SV_TEXT = [
    'module shadow_edit;',
    '  logic [7:0] val;',
    '  logic en;',
    '  always_comb begin : blk',
    "    val = en ? 4'hF : 4'h0;",
    '  end',
    "  assign val = 8'h00;",
    'endmodule',
    '',
].join('\n');

export const EDIT_BUFFER_SV_TEXT = [
    'module shadow_edit;',
    '  logic [7:0] val;',
    '  logic en;',
    '  always_comb begin : blk',
    '    logic [3:0] val;',
    "    val = en ? 4'hF : 4'h0;",
    '  end',
    "  assign val = 8'h00;",
    'endmodule',
    '',
].join('\n');

/** v1 schema config with lint disabled so publications stay clean; `include`
 *  must be explicit because a partial `[sources]` table would otherwise
 *  discover nothing. */
export const SHADOWING_LLG_TOML_TEXT = [
    'schema_version = 1',
    '',
    '[sources]',
    'directories = ["."]',
    'include = ["**/*.v", "**/*.sv"]',
    '',
    '[lint]',
    'enabled = false',
    '',
].join('\n');

function fileUri(p: string): string {
    return pathToFileURL(p).href;
}

/**
 * Builds a fresh read-only fixture workspace under os.tmpdir():
 *
 *   <base>/ws/llg.toml        (lint disabled)
 *   <base>/ws/blk.sv           named begin/end block shadowing
 *   <base>/ws/func.sv          function-local shadowing
 *   <base>/ws/task.sv          task-local shadowing
 *   <base>/ws/gen.sv           generate-block shadowing
 *   <base>/ws/two.sv           two-level nesting
 *   <base>/ws/leaf.sv          child module (instance-namespace case)
 *   <base>/ws/tb_nested.sv     tb with same-name net + block shadow
 *   <base>/ws/cross_leaf.sv    child module (cross-file case)
 *   <base>/ws/tb_cross.sv      tb shadowing the child's port name locally
 *   <base>/ws/edit.sv          baseline without the inner block
 *
 * Directories are named `<prefix>-<pid>-<counter>-<rand>` so concurrent test
 * processes never collide.
 */
export function createShadowingFixture(prefix = 'hdlsupport-shadow'): ShadowingFixture {
    fixtureCounter += 1;
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${process.pid}-${fixtureCounter}-`));
    const projectDir = path.join(baseDir, 'ws');
    fs.mkdirSync(projectDir, { recursive: true });

    const write = (name: string, text: string): string => {
        const filePath = path.join(projectDir, name);
        fs.writeFileSync(filePath, text);
        return filePath;
    };

    const configPath = write('llg.toml', SHADOWING_LLG_TOML_TEXT);
    const blkPath = write('blk.sv', BLK_SV_TEXT);
    const funcPath = write('func.sv', FUNC_SV_TEXT);
    const taskPath = write('task.sv', TASK_SV_TEXT);
    const genPath = write('gen.sv', GEN_SV_TEXT);
    const twoPath = write('two.sv', TWO_SV_TEXT);
    const leafPath = write('leaf.sv', LEAF_SV_TEXT);
    const tbNestedPath = write('tb_nested.sv', TB_NESTED_SV_TEXT);
    const crossLeafPath = write('cross_leaf.sv', CROSS_LEAF_SV_TEXT);
    const tbCrossPath = write('tb_cross.sv', TB_CROSS_SV_TEXT);
    const editBasePath = write('edit.sv', EDIT_BASE_SV_TEXT);

    let disposed = false;
    return {
        baseDir,
        projectDir,
        configPath,
        blkPath,
        funcPath,
        taskPath,
        genPath,
        twoPath,
        leafPath,
        tbNestedPath,
        crossLeafPath,
        tbCrossPath,
        editBasePath,
        blkUri: fileUri(blkPath),
        funcUri: fileUri(funcPath),
        taskUri: fileUri(taskPath),
        genUri: fileUri(genPath),
        twoUri: fileUri(twoPath),
        leafUri: fileUri(leafPath),
        tbNestedUri: fileUri(tbNestedPath),
        crossLeafUri: fileUri(crossLeafPath),
        tbCrossUri: fileUri(tbCrossPath),
        editBaseUri: fileUri(editBasePath),
        dispose(): void {
            if (!disposed) {
                disposed = true;
                fs.rmSync(baseDir, { recursive: true, force: true });
            }
        },
    };
}
