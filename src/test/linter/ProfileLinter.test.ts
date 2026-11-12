// SPDX-License-Identifier: MIT
/* eslint-disable @typescript-eslint/naming-convention -- VS Code API members use PascalCase. */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type * as child from 'child_process';
import { stat } from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../../logger';
import ProfileLinter from '../../linter/ProfileLinter';
import { executeFile, terminateProcess } from '../../linter/processExecution';
import { verilator } from '../../linter/profiles/verilator';
import { xvlog } from '../../linter/profiles/xvlog';

const FILESYSTEM_ROOT = path.parse(process.cwd()).root;
const WORKSPACE_ROOT = path.join(FILESYSTEM_ROOT, 'workspaces', 'chip project');
const SOURCE_FILE = path.join(WORKSPACE_ROOT, 'rtl', 'top.sv');
const TOOL_EXECUTABLE = path.join(FILESYSTEM_ROOT, 'opt', 'HDL Tools', 'verilator binary');
const DEFAULT_VERILATOR = process.platform === 'win32' ? 'verilator_bin.exe' : 'verilator';

type ExecFileCallback = (
    error: child.ExecFileException | null,
    stdout: string | Buffer,
    stderr: string | Buffer,
) => void;

const { mockState } = vi.hoisted(() => ({
    mockState: {
        workspaceRoot: '',
        toolSettings: {} as Record<string, unknown>,
        lintingSettings: {} as Record<string, unknown>,
        files: {} as Record<string, string>,
    },
}));

vi.mock('../../linter/processExecution', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../linter/processExecution')>(),
    executeFile: vi.fn(),
    terminateProcess: vi.fn((process: { kill: () => void }) => process.kill()),
}));

vi.mock('fs/promises', () => ({
    stat: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    const missing = (): Error => Object.assign(new Error('missing'), { code: 'ENOENT' });
    const mocked = {
        ...actual,
        statSync: vi.fn((file: string) => {
            if (!(file in mockState.files)) { throw missing(); }
            return { isFile: () => true };
        }),
        readFileSync: vi.fn((file: string) => {
            if (!(file in mockState.files)) { throw missing(); }
            return mockState.files[file];
        }),
    };
    return { ...mocked, default: mocked };
});

vi.mock('vscode', () => {
    class Range {
        constructor(
            public readonly startLine: number,
            public readonly startCharacter: number,
            public readonly endLine: number,
            public readonly endCharacter: number,
        ) {}
    }

    const uri = (fsPath: string) => ({
        fsPath,
        toString: () => `file://${fsPath}`,
    });
    const configuration = (values: Record<string, unknown>) => ({
        get: vi.fn(<T>(key: string, fallback?: T): T => (values[key] as T | undefined) ?? fallback as T),
        inspect: vi.fn(<T>(key: string) => Object.prototype.hasOwnProperty.call(values, key)
            ? { workspaceFolderValue: values[key] as T }
            : undefined),
    });

    return {
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        Range,
        Uri: { file: vi.fn(uri) },
        workspace: {
            getWorkspaceFolder: vi.fn(() => ({ uri: uri(mockState.workspaceRoot) })),
            getConfiguration: vi.fn((section: string) => {
                if (/^hdlsupport\.verilog\.linting\.(verilator|xvlog)$/.test(section)) {
                    return configuration(mockState.toolSettings);
                }
                if (section === 'hdlsupport.verilog.linting') {
                    return configuration(mockState.lintingSettings);
                }
                return configuration({});
            }),
        },
    };
});

const fakeLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    show: vi.fn(),
} as unknown as Logger;

function document(fileName = SOURCE_FILE): vscode.TextDocument {
    return {
        fileName,
        languageId: 'systemverilog',
        uri: { fsPath: fileName, toString: () => `file://${fileName}` },
    } as vscode.TextDocument;
}

function successfulProcess(stdout = '', stderr = ''): { kill: Mock } {
    const process = { kill: vi.fn() };
    (executeFile as unknown as Mock).mockImplementationOnce(
        (_executable: string, _args: string[], _options: child.ExecFileOptions, callback: ExecFileCallback) => {
            callback(null, stdout, stderr);
            return process;
        },
    );
    return process;
}

describe('ProfileLinter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockState.workspaceRoot = WORKSPACE_ROOT;
        mockState.toolSettings = {};
        mockState.lintingSettings = {};
        mockState.files = {};
        (stat as unknown as Mock).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    });

    it('uses the resource workspace for cwd and llg.toml directories for include arguments', async () => {
        mockState.toolSettings = {
            path: TOOL_EXECUTABLE,
            arguments: `--define 'VALUE=$(touch /tmp/never-created)'`,
        };
        mockState.files = {
            [path.join(WORKSPACE_ROOT, 'llg.toml')]: [
                '[sources]',
                'directories = ["rtl", "vendor includes"]',
                '[compile]',
                'include_dirs = ["headers"]',
            ].join('\n'),
        };
        successfulProcess('', '');
        const linter = new ProfileLinter(verilator, fakeLogger);

        const result = await linter.startLint(document());

        expect(executeFile).toHaveBeenCalledWith(
            TOOL_EXECUTABLE,
            [
                `-I${path.dirname(SOURCE_FILE)}`,
                `-I${path.join(WORKSPACE_ROOT, 'vendor includes')}`,
                `-I${path.join(WORKSPACE_ROOT, 'headers')}`,
                '--define',
                'VALUE=$(touch /tmp/never-created)',
                SOURCE_FILE,
            ],
            {
                cwd: WORKSPACE_ROOT,
                timeout: 60_000,
                maxBuffer: 16 * 1024 * 1024,
            },
            expect.any(Function),
        );
        expect(result).toEqual({
            clearExisting: false,
            replaceOwned: true,
            diagnostics: [{
                uri: expect.objectContaining({ fsPath: SOURCE_FILE }),
                diagnostics: [],
            }],
        });
    });

    it('passes the built-in default arguments after the include directories and falls back to the workspace root', async () => {
        successfulProcess('', '');
        const linter = new ProfileLinter(verilator, fakeLogger);

        await linter.startLint(document());

        expect((executeFile as unknown as Mock).mock.calls[0][1]).toEqual([
            `-I${path.dirname(SOURCE_FILE)}`,
            `-I${WORKSPACE_ROOT}`,
            ...verilator.defaultArguments,
            SOURCE_FILE,
        ]);
    });

    it('prefers the closest llg.toml below the workspace root and defaults sources to its directory', async () => {
        const nested = path.join(WORKSPACE_ROOT, 'rtl');
        mockState.files = {
            [path.join(nested, 'llg.toml')]: '[compile]\ninclude_dirs = ["inc"]\n',
            [path.join(WORKSPACE_ROOT, 'llg.toml')]: '[sources]\ndirectories = ["other"]\n',
        };
        successfulProcess('', '');
        const linter = new ProfileLinter(verilator, fakeLogger);

        await linter.startLint(document());

        expect((executeFile as unknown as Mock).mock.calls[0][1]).toEqual([
            `-I${nested}`,
            `-I${path.join(nested, 'inc')}`,
            ...verilator.defaultArguments,
            SOURCE_FILE,
        ]);
    });

    it('maps diagnostics for included files while also clearing the requested document', async () => {
        successfulProcess('', [
            '%Warning-WIDTH: ../shared/include.svh:8:3: signal width: expected 8 bits',
            '%Error: rtl/top.sv:11: syntax error: unexpected token',
        ].join('\n'));
        const linter = new ProfileLinter(verilator, fakeLogger);

        const result = await linter.startLint(document());

        expect(result).toMatchObject({ clearExisting: false, replaceOwned: true });
        expect(result.diagnostics).toEqual([
            {
                uri: expect.objectContaining({ fsPath: SOURCE_FILE }),
                diagnostics: [{
                    range: new vscode.Range(10, 0, 10, Number.MAX_VALUE),
                    severity: vscode.DiagnosticSeverity.Error,
                    message: 'syntax error: unexpected token',
                    source: 'verilator',
                    code: 'verilator',
                }],
            },
            {
                uri: expect.objectContaining({ fsPath: path.resolve(WORKSPACE_ROOT, '..', 'shared', 'include.svh') }),
                diagnostics: [{
                    range: new vscode.Range(7, 2, 7, Number.MAX_VALUE),
                    severity: vscode.DiagnosticSeverity.Warning,
                    message: 'signal width: expected 8 bits',
                    source: 'verilator',
                    code: 'WIDTH',
                }],
            },
        ]);
    });

    it('runs any linter inside WSL on Windows when useWSL is set', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            mockState.toolSettings = { useWSL: true };
            (executeFile as unknown as Mock).mockImplementation(
                (executable: string, args: string[], _options: child.ExecFileOptions, callback: ExecFileCallback) => {
                    // `wsl --exec wslpath -u <path>` maps every path under /mnt.
                    callback(null, executable === 'wsl' && args.includes('wslpath') ? `/mnt${args[args.length - 1]}\n` : '', '');
                    return { kill: vi.fn() };
                },
            );
            const linter = new ProfileLinter(xvlog, fakeLogger);

            await linter.startLint(document());

            const [executable, args] = (executeFile as unknown as Mock).mock.calls.at(-1) ?? [];
            expect(executable).toBe('wsl');
            expect(args.slice(0, 4)).toEqual(['--cd', `/mnt${WORKSPACE_ROOT}`, '--exec', 'xvlog']);
            expect(args.at(-1)).toBe(`/mnt${SOURCE_FILE}`);
        } finally {
            (executeFile as unknown as Mock).mockReset();
            if (platform) { Object.defineProperty(process, 'platform', platform); }
        }
    });

    it('runs at the source file location when configured', async () => {
        mockState.lintingSettings = { runAtFileLocation: true };
        successfulProcess('', '');
        const linter = new ProfileLinter(verilator, fakeLogger);
        const outsideFile = path.join(FILESYSTEM_ROOT, 'outside checkout', 'design', 'top.sv');

        await linter.startLint(document(outsideFile));

        expect(executeFile).toHaveBeenCalledWith(
            DEFAULT_VERILATOR,
            expect.any(Array),
            expect.objectContaining({ cwd: path.dirname(outsideFile) }),
            expect.any(Function),
        );
    });

    it('reports process launch failures with the available tool output', async () => {
        const process = { kill: vi.fn() };
        const error = Object.assign(new Error('spawn verilator ENOENT'), { code: 'ENOENT' });
        (executeFile as unknown as Mock).mockImplementationOnce(
            (_executable: string, _args: string[], _options: child.ExecFileOptions, callback: ExecFileCallback) => {
                callback(error, '', 'verilator was not found');
                return process;
            },
        );
        const linter = new ProfileLinter(verilator, fakeLogger);

        await expect(linter.startLint(document())).rejects.toThrow(
            'verilator: spawn verilator ENOENT\nverilator was not found',
        );
    });

    it('kills an in-flight process and suppresses publication when disposed', async () => {
        const process = { kill: vi.fn() };
        (executeFile as unknown as Mock).mockImplementationOnce(() => process);
        const linter = new ProfileLinter(verilator, fakeLogger);

        const run = linter.startLint(document());
        await vi.waitFor(() => expect(executeFile).toHaveBeenCalledTimes(1));
        linter.dispose();

        await expect(run).resolves.toEqual({ diagnostics: [], clearExisting: false });
        expect(terminateProcess).toHaveBeenCalledWith(process);
        expect(process.kill).toHaveBeenCalledTimes(1);
    });
});
