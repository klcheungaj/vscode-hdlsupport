import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

let fixtureCounter = 0;

export interface WorkspaceFixture {
    /** Temporary base directory (unique per call). */
    readonly baseDir: string;
    /** The workspace root handed to the server: `<baseDir>/proj`. */
    readonly projectDir: string;
    readonly configPath: string;
    readonly topPath: string;
    readonly childPath: string;
    readonly projectUri: string;
    readonly topUri: string;
    readonly childUri: string;
    /** Recursive content checksum captured right after creation. */
    checksum: string;
    /** Removes the whole tree; safe to call twice. */
    dispose(): void;
}

export const TOP_SV_TEXT = [
    'module top (',
    '    input logic clk',
    ');',
    '',
    '    logic unused_sig;',
    '',
    '    child u_child_small (',
    '        .clk (clk)',
    '    );',
    '',
    '    child u_child_wide (',
    '        .clk (clk)',
    '    );',
    '',
    'endmodule',
    '',
].join('\n');

export const CHILD_SV_TEXT = [
    'module child #(',
    '    parameter int WIDTH = 8',
    ') (',
    '    input  logic              clk,',
    '    output logic [WIDTH-1:0] data,',
    '    output logic [1:0]       lane',
    ');',
    '',
    '    logic [WIDTH-1:0] unused_sig;',
    'endmodule',
    '',
].join('\n');

/** v1 schema config with the unused-signal lint rule explicitly disabled.
 *  `include` must be explicit: defaults only apply when the whole file is
 *  missing, so a partial `[sources]` table would otherwise discover nothing. */
export const LLG_TOML_TEXT = [
    'schema_version = 1',
    '',
    '[sources]',
    'directories = ["."]',
    'include = ["**/*.v", "**/*.sv"]',
    '',
    '[lint.rules.unused-signal]',
    'enabled = false',
    '',
].join('\n');

function fileUri(p: string): string {
    return pathToFileURL(p).href;
}

/**
 * Builds a fresh read-only fixture workspace under os.tmpdir():
 *
 *   <base>/proj/llg.toml
 *   <base>/proj/top.sv     (module top with unused_sig + two child instances)
 *   <base>/proj/child.sv   (multiline parameter/port declarations + signal)
 *
 * Directories are named `<prefix>-<pid>-<counter>-<rand>` so concurrent test
 * processes never collide.
 */
export function createWorkspaceFixture(prefix = 'hdlsupport-e2e'): WorkspaceFixture {
    fixtureCounter += 1;
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${process.pid}-${fixtureCounter}-`));
    const projectDir = path.join(baseDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });

    const configPath = path.join(projectDir, 'llg.toml');
    const topPath = path.join(projectDir, 'top.sv');
    const childPath = path.join(projectDir, 'child.sv');
    fs.writeFileSync(configPath, LLG_TOML_TEXT);
    fs.writeFileSync(topPath, TOP_SV_TEXT);
    fs.writeFileSync(childPath, CHILD_SV_TEXT);

    let disposed = false;
    return {
        baseDir,
        projectDir,
        configPath,
        topPath,
        childPath,
        projectUri: fileUri(projectDir),
        topUri: fileUri(topPath),
        childUri: fileUri(childPath),
        checksum: computeTreeChecksum(projectDir),
        dispose(): void {
            if (!disposed) {
                disposed = true;
                fs.rmSync(baseDir, { recursive: true, force: true });
            }
        },
    };
}

/** Recomputes the recursive checksum of a directory tree. */
export function computeTreeChecksum(rootDir: string): string {
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
                entries.push({
                    relative,
                    hash: sha256File(absolute),
                });
            }
        }
    }
}

function sha256File(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Names of `llg-{pid}-{rand}` shadow directories currently inside os.tmpdir().
 * The Lapligence server stages unsaved-buffer copies there and removes them on exit.
 */
export function listTmpLlgShadowDirs(): Set<string> {
    try {
        return new Set(fs.readdirSync(os.tmpdir()).filter((name) => /^llg-\d+-/.test(name)));
    } catch {
        return new Set();
    }
}

/** 0-based LSP position of `needle` (+`offset` bytes) inside `text`. */
export function positionAt(text: string, needle: string, offset = 0): { line: number; character: number } {
    const index = text.indexOf(needle);
    if (index < 0) {
        throw new Error(`needle ${JSON.stringify(needle)} not found in fixture text`);
    }
    if (offset > needle.length) {
        throw new Error('offset extends beyond the needle');
    }
    const upto = index + offset;
    const line = text.slice(0, upto).split('\n').length - 1;
    const lineStart = text.lastIndexOf('\n', upto - 1) + 1;
    return { line, character: upto - lineStart };
}
