// SPDX-License-Identifier: MIT
/* eslint-disable @typescript-eslint/naming-convention -- VS Code API members use PascalCase. */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type * as child from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../../logger';
import ProfileFormatter, { FORMATTER_LANGUAGES } from '../../formatter/ProfileFormatter';
import { findFormatterProfile, formatterProfiles } from '../../formatter/profiles';
import { verible } from '../../formatter/profiles/verible';
import { executeFile, terminateProcess } from '../../linter/processExecution';

const SOURCE_FILE = path.join(path.parse(process.cwd()).root, 'workspaces', 'chip project', 'rtl', 'top.sv');
const SOURCE = 'module top;\nendmodule\n';
const DEFAULT_VERIBLE = process.platform === 'win32' ? 'verible-verilog-format.exe' : 'verible-verilog-format';

type ExecFileCallback = (error: child.ExecFileException | null, stdout: string, stderr: string) => void;

const { mockState } = vi.hoisted(() => ({
    mockState: {
        formatter: 'verible',
        toolSettings: {} as Record<string, unknown>,
    },
}));

vi.mock('../../linter/processExecution', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../linter/processExecution')>(),
    executeFile: vi.fn(),
    terminateProcess: vi.fn(),
}));

vi.mock('vscode', () => {
    class Position {
        constructor(public readonly line: number, public readonly character: number) {}
    }
    class Range {
        constructor(public readonly start: Position, public readonly end: Position) {}
    }
    const configuration = (values: Record<string, unknown>) => ({
        get: <T>(key: string, fallback: T): T => (values[key] as T | undefined) ?? fallback,
    });
    return {
        Position,
        Range,
        TextEdit: { replace: (range: Range, newText: string) => ({ range, newText }) },
        window: { showErrorMessage: vi.fn() },
        workspace: {
            getConfiguration: vi.fn((section: string) => section === 'hdlsupport.verilog.formatting'
                ? configuration({ formatter: mockState.formatter })
                : configuration(section === 'hdlsupport.verilog.formatting.verible' ? mockState.toolSettings : {})),
        },
    };
});

const fakeLogger = { info: vi.fn(), error: vi.fn() } as unknown as Logger;

function document(languageId = 'systemverilog'): vscode.TextDocument {
    return {
        fileName: SOURCE_FILE,
        languageId,
        uri: { fsPath: SOURCE_FILE },
        getText: () => SOURCE,
        positionAt: (offset: number) => new vscode.Position(0, offset),
    } as unknown as vscode.TextDocument;
}

function token(cancelled = false): vscode.CancellationToken & { cancel(): void } {
    const listeners: (() => void)[] = [];
    const state = {
        isCancellationRequested: cancelled,
        onCancellationRequested: (listener: () => void) => {
            listeners.push(listener);
            return { dispose: vi.fn() };
        },
        cancel: () => {
            state.isCancellationRequested = true;
            listeners.forEach(listener => listener());
        },
    };
    return state as unknown as vscode.CancellationToken & { cancel(): void };
}

function respond(error: Partial<child.ExecFileException> | null, stdout = '', stderr = ''): void {
    (executeFile as unknown as Mock).mockImplementationOnce(
        (_executable: string, _args: string[], _options: child.ExecFileOptions, callback: ExecFileCallback) => {
            callback(error as child.ExecFileException | null, stdout, stderr);
            return { once: vi.fn() };
        },
    );
}

const formatDocument = (doc = document(), cancellation = token()) =>
    new ProfileFormatter(fakeLogger).provideDocumentFormattingEdits(doc, {} as vscode.FormattingOptions, cancellation);

describe('formatter profile registry', () => {
    it('exposes verible and registers its languages', () => {
        expect(formatterProfiles.map(profile => profile.id)).toEqual(['verible']);
        expect(findFormatterProfile('verible')).toBe(verible);
        expect(findFormatterProfile('none')).toBeUndefined();
        expect(FORMATTER_LANGUAGES).toEqual(['verilog', 'systemverilog']);
    });
});

describe('ProfileFormatter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockState.formatter = 'verible';
        mockState.toolSettings = {};
    });

    it('pipes the document through verible and replaces the whole document', async () => {
        respond(null, 'module top;\nendmodule : top\n');

        const edits = await formatDocument();

        expect(executeFile).toHaveBeenCalledWith(
            DEFAULT_VERIBLE,
            ['-'],
            { cwd: path.dirname(SOURCE_FILE), timeout: 60_000, maxBuffer: 64 * 1024 * 1024, input: SOURCE },
            expect.any(Function),
        );
        expect(edits).toEqual([{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: SOURCE.length } },
            newText: 'module top;\nendmodule : top\n',
        }]);
    });

    it('puts user arguments and one-based line ranges before the stdin flag', async () => {
        mockState.toolSettings = { path: '/opt/verible/bin/verible-verilog-format', arguments: '--indentation_spaces 4' };
        respond(null, SOURCE);
        const range = new vscode.Range(new vscode.Position(2, 0), new vscode.Position(5, 3));

        const edits = await new ProfileFormatter(fakeLogger)
            .provideDocumentRangeFormattingEdits(document(), range, {} as vscode.FormattingOptions, token());

        expect((executeFile as unknown as Mock).mock.calls[0].slice(0, 2)).toEqual([
            '/opt/verible/bin/verible-verilog-format',
            ['--indentation_spaces', '4', '--lines=3-6', '-'],
        ]);
        expect(edits).toEqual([]);
    });

    it('does nothing when formatting is disabled or the language is unsupported', async () => {
        mockState.formatter = 'none';
        expect(await formatDocument()).toEqual([]);
        mockState.formatter = 'verible';
        expect(await formatDocument(document('vhdl'))).toEqual([]);
        expect(executeFile).not.toHaveBeenCalled();
    });

    it('reports a missing executable with the setting to fix it', async () => {
        respond({ code: 'ENOENT', message: 'spawn ENOENT' });

        expect(await formatDocument()).toEqual([]);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            `Verible formatter '${DEFAULT_VERIBLE}' was not found. Install it or set hdlsupport.verilog.formatting.verible.path.`,
        );
    });

    it('rejects with the tool stderr when formatting fails', async () => {
        respond({ code: 1, message: 'Command failed' }, '', 'top.sv:1:1: syntax error\n');

        await expect(formatDocument()).rejects.toThrow('Verible could not format top.sv: top.sv:1:1: syntax error');
    });

    it('terminates the tool and returns no edits when cancelled', async () => {
        const started = { once: vi.fn() };
        (executeFile as unknown as Mock).mockImplementationOnce(() => started);
        const cancellation = token();

        const pending = formatDocument(document(), cancellation);
        await vi.waitFor(() => expect(executeFile).toHaveBeenCalled());
        cancellation.cancel();

        expect(await pending).toEqual([]);
        expect(terminateProcess).toHaveBeenCalledWith(started);
    });
});
