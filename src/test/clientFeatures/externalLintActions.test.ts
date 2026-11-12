// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('vscode', () => {
    class CodeAction {
        diagnostics?: unknown[];
        isPreferred?: boolean;
        edit?: WorkspaceEdit;
        command?: unknown;

        constructor(readonly title: string, readonly kind: string) {}
    }
    class WorkspaceEdit {
        readonly insert = vi.fn();
    }
    const state = {
        provider: undefined as { provideCodeActions(document: any, range: any, context: any): any[] } | undefined,
        command: undefined as ((uri: any, id: string) => Promise<void>) | undefined,
        configured: [] as unknown,
        update: vi.fn(),
        workspaceFolder: { name: 'project' } as unknown,
    };
    return {
        __test: state,
        CodeAction,
        CodeActionKind: { QuickFix: 'quickfix', Empty: '' },
        WorkspaceEdit,
        ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 },
        Uri: {
            parse: (value: string) => ({ value, toString: () => value }),
            file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }),
        },
        commands: {
            registerCommand: vi.fn((_name: string, command: (uri: any, id: string) => Promise<void>) => {
                state.command = command;
                return { dispose: vi.fn() };
            }),
        },
        languages: {
            registerCodeActionsProvider: vi.fn((_selector: unknown, provider: typeof state.provider) => {
                state.provider = provider;
                return { dispose: vi.fn() };
            }),
        },
        workspace: {
            getConfiguration: vi.fn(() => ({
                get: vi.fn(() => state.configured),
                update: state.update,
            })),
            getWorkspaceFolder: vi.fn(() => state.workspaceFolder),
        },
    };
});

import * as vscode from 'vscode';
import { registerExternalLintActions } from '../../clientFeatures/externalLintActions';

interface TestState {
    provider?: { provideCodeActions(document: any, range: any, context: any): any[] };
    command?: (uri: any, id: string) => Promise<void>;
    configured: unknown;
    update: Mock;
    workspaceFolder: unknown;
}

const state = (vscode as typeof vscode & { __test: TestState }).__test;

function diagnostic(source = 'verilator', code: unknown = 'UNUSEDSIGNAL', line = 0): any {
    return {
        source,
        code,
        range: { start: { line }, end: { line } },
        message: 'unused signal',
    };
}

describe('external-linter code actions', () => {
    beforeEach(() => {
        state.provider = undefined;
        state.command = undefined;
        state.configured = [];
        state.workspaceFolder = { name: 'project' };
        state.update.mockReset();
        registerExternalLintActions({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    });

    it('offers line, workspace, and Verilator documentation actions once per line and rule', () => {
        const lineEnd = { line: 0, character: 20 };
        const document = {
            uri: vscode.Uri.file('/tmp/top.sv'),
            lineCount: 2,
            lineAt: () => ({ range: { end: lineEnd } }),
        };
        const issue = diagnostic();

        const actions = state.provider?.provideCodeActions(document, {}, { diagnostics: [issue, issue] }) ?? [];

        expect(actions.map((action) => action.title)).toEqual([
            'Waive verilator:unusedsignal on this line',
            'Waive verilator:unusedsignal in this workspace',
            'Open documentation for verilator:unusedsignal',
        ]);
        expect(actions[0].edit.insert).toHaveBeenCalledWith(
            document.uri,
            lineEnd,
            ' // hdlsupport-lint-waive verilator:unusedsignal',
        );
        expect(actions[1].command.arguments).toEqual([document.uri, 'verilator:unusedsignal']);
        expect(actions[2].command.arguments[0].toString()).toContain('#cmdoption-Wno-UNUSEDSIGNAL');
    });

    it('ignores language-server, uncoded, and out-of-range diagnostics', () => {
        const document = { uri: vscode.Uri.file('/tmp/top.sv'), lineCount: 1, lineAt: vi.fn() };

        const actions = state.provider?.provideCodeActions(document, {}, {
            diagnostics: [diagnostic('llg-lint'), diagnostic('slang', null), diagnostic('xvlog', 'VRFC', 4)],
        }) ?? [];

        expect(actions).toEqual([]);
        expect(document.lineAt).not.toHaveBeenCalled();
    });

    it('normalizes and stores a workspace-folder waiver without duplicating it', async () => {
        const uri = vscode.Uri.file('/tmp/top.sv');
        state.configured = ['slang:unused'];

        await state.command?.(uri, 'Verilator:UNUSEDSIGNAL');

        expect(state.update).toHaveBeenCalledWith(
            'waivedDiagnostics',
            ['slang:unused', 'verilator:unusedsignal'],
            vscode.ConfigurationTarget.WorkspaceFolder,
        );

        state.update.mockClear();
        state.configured = ['VERILATOR:UNUSEDSIGNAL'];
        await state.command?.(uri, 'verilator:unusedsignal');
        expect(state.update).not.toHaveBeenCalled();
    });

    it('uses workspace scope outside a folder and rejects malformed command arguments', async () => {
        const uri = vscode.Uri.file('/tmp/top.sv');
        state.workspaceFolder = undefined;
        state.configured = 'malformed-setting';

        await state.command?.(uri, 'modelsim:modelsim');
        expect(state.update).toHaveBeenCalledWith(
            'waivedDiagnostics',
            ['modelsim:modelsim'],
            vscode.ConfigurationTarget.Workspace,
        );

        state.update.mockClear();
        await state.command?.(uri, 'not-an-id');
        expect(state.update).not.toHaveBeenCalled();
    });
});
