// SPDX-License-Identifier: MIT

import * as path from 'path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('vscode', () => {
    class Disposable {
        constructor(private readonly onDispose: () => void = () => undefined) {}

        dispose(): void {
            this.onDispose();
        }
    }

    const settings: Record<string, string> = { path: '', logLevel: 'warn', configPath: '' };
    const outputChannel = {
        appendLine: vi.fn(),
        dispose: vi.fn(),
        show: vi.fn(),
    };
    return {
        Disposable,
        Uri: {
            file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }),
        },
        window: {
            createOutputChannel: vi.fn(() => outputChannel),
            showErrorMessage: vi.fn(),
        },
        RelativePattern: class {
            constructor(readonly base: { fsPath: string }, readonly pattern: string) {}
        },
        workspace: {
            workspaceFolders: [] as Array<{ uri: { fsPath: string }; name: string }>,
            getConfiguration: vi.fn(() => ({
                get: (key: string, fallback: string) => settings[key] ?? fallback,
            })),
            findFiles: vi.fn(async () => []),
            createFileSystemWatcher: vi.fn(() => ({
                dispose: vi.fn(),
                onDidCreate: vi.fn(() => new Disposable()),
                onDidDelete: vi.fn(() => new Disposable()),
            })),
            onDidChangeWorkspaceFolders: vi.fn(() => new Disposable()),
        },
        __settings: settings,
        __outputChannel: outputChannel,
    };
});

vi.mock('vscode-languageclient/node', () => {
    const clients: Array<{ sendRequest: Mock; notify(method: string): void; options?: Record<string, unknown> }> = [];
    class NotificationType {
        constructor(readonly method: string) {}
    }
    class FakeLanguageClient {
        state = 1;
        readonly handlers = new Map<string, () => void>();
        readonly sendRequest = vi.fn();
        readonly features = new Map<string, { initialize(): void }>();

        readonly options?: Record<string, unknown>;

        constructor(_id: string, _name: string, _serverOptions: unknown, options?: Record<string, unknown>) {
            this.options = options;
            clients.push(this);
        }

        getFeature(method: string): { initialize(): void } {
            const feature = this.features.get(method) ?? { initialize: vi.fn() };
            this.features.set(method, feature);
            return feature;
        }

        onNotification(type: NotificationType, handler: () => void): void {
            this.handlers.set(type.method, handler);
        }

        async start(): Promise<void> {
            this.state = 2;
        }

        protected fillInitializeParams(params: { workspaceFolders?: unknown[] | null }): void {
            params.workspaceFolders = [{ uri: 'file:///ws', name: 'ws' }];
        }

        async stop(): Promise<void> {
            this.state = 1;
        }

        notify(method: string): void {
            this.handlers.get(method)?.();
        }
    }
    return {
        CloseAction: { DoNotRestart: 0, Restart: 1 },
        ErrorAction: { Continue: 0, Shutdown: 1 },
        LanguageClient: FakeLanguageClient,
        NotificationType,
        RenameRequest: { method: 'textDocument/rename' },
        State: { Stopped: 1 },
        TransportKind: { stdio: 0 },
        __clients: clients,
    };
});
vi.mock('../../languageServer/resolve', () => ({
    resolveServerExecutable: vi.fn(() => ({ kind: 'path', path: '/tmp/llg' })),
    validateExecutable: vi.fn(async () => null),
}));

import * as vscode from 'vscode';
import * as languageClient from 'vscode-languageclient/node';
import {
    buildServerArguments,
    createLlgClientManager,
    isMethodNotFoundError,
    MODULE_EXPLORER_REQUEST,
    MODULE_EXPLORER_CHANGED_NOTIFICATION,
    resolveServerCommand,
    TEST_MODE_ENV,
    TEST_NODE_EXECUTABLE_ENV,
    TEST_SERVER_MODULE_ENV,
} from '../../languageServer/llgClient';

const vscodeTestApi = vscode as typeof vscode & {
    __settings: Record<string, string>;
};
const languageClientTestApi = languageClient as typeof languageClient & {
    __clients: Array<{
        sendRequest: Mock;
        notify(method: string): void;
        options?: {
            diagnosticCollectionName?: string;
            middleware?: {
                handleDiagnostics?: (
                    uri: { toString(): string },
                    diagnostics: Array<{ source?: string }>,
                    next: (uri: unknown, diagnostics: unknown[]) => void,
                ) => void;
            };
        };
    }>;
};

function context(): vscode.ExtensionContext {
    return {
        extensionUri: { fsPath: '/extension' },
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

describe('isMethodNotFoundError', () => {
    it('recognizes the JSON-RPC MethodNotFound code', () => {
        expect(isMethodNotFoundError({ code: -32601 })).toBe(true);
        expect(isMethodNotFoundError(new Error('method not found'))).toBe(true);
    });

    it('does not classify unrelated request failures as compatibility fallback', () => {
        expect(isMethodNotFoundError({ code: -32600 })).toBe(false);
        expect(isMethodNotFoundError(new Error('connection closed'))).toBe(false);
    });
});

describe('guarded desktop-test server launch', () => {
    it('leaves the production command and arguments unchanged when test mode is off', () => {
        const executable = path.resolve('configured-llg');

        expect(resolveServerCommand(executable, {})).toBe(executable);
        expect(buildServerArguments(executable, {})).toEqual([]);
    });

    it('runs the fake server module with the parent Node executable in test mode', () => {
        const modulePath = path.resolve('fake-server.js');
        const nodePath = process.execPath;
        const environment = {
            [TEST_MODE_ENV]: '1',
            [TEST_NODE_EXECUTABLE_ENV]: nodePath,
            [TEST_SERVER_MODULE_ENV]: modulePath,
        };

        expect(resolveServerCommand('/configured/llg', environment)).toBe(nodePath);
        expect(buildServerArguments('/configured/llg', environment)).toEqual([modulePath]);
    });

    it('rejects test mode without absolute runner paths', () => {
        expect(() => resolveServerCommand('/configured/llg', {
            [TEST_MODE_ENV]: '1',
        })).toThrow(`${TEST_MODE_ENV}=1`);
        expect(() => buildServerArguments('/configured/llg', {
            [TEST_MODE_ENV]: '1',
            [TEST_SERVER_MODULE_ENV]: 'fake-server.js',
        })).toThrow(`${TEST_MODE_ENV}=1`);
    });
});

describe('LlgClientManager module explorer integration', () => {
    beforeEach(() => {
        vscodeTestApi.__settings.path = '';
        vscodeTestApi.__settings.logLevel = 'warn';
        vscodeTestApi.__settings.configPath = '';
        languageClientTestApi.__clients.length = 0;
        vi.clearAllMocks();
    });

    it('caches a snapshot, invalidates on notification, and keeps notification handlers across restart', async () => {
        const manager = createLlgClientManager(context());
        const first = { roots: [], modules: [] };
        const second = { roots: [], modules: [] };

        await manager.start();
        const client = languageClientTestApi.__clients[0];
        client.sendRequest.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const notifications: number[] = [];
        manager.onModuleExplorerChanged(() => notifications.push(1));

        await expect(manager.getModuleExplorerSnapshot()).resolves.toBe(first);
        await expect(manager.getModuleExplorerSnapshot()).resolves.toBe(first);
        expect(client.sendRequest).toHaveBeenCalledTimes(1);
        expect(client.sendRequest).toHaveBeenCalledWith(MODULE_EXPLORER_REQUEST, {});

        client.notify(MODULE_EXPLORER_CHANGED_NOTIFICATION.method);
        expect(notifications).toEqual([1]);
        await expect(manager.getModuleExplorerSnapshot()).resolves.toBe(second);
        expect(client.sendRequest).toHaveBeenCalledTimes(2);

        await manager.restart();
        const restartedClient = languageClientTestApi.__clients[1];
        restartedClient.sendRequest.mockResolvedValue(first);
        restartedClient.notify(MODULE_EXPLORER_CHANGED_NOTIFICATION.method);
        expect(notifications).toEqual([1, 1]);
        await manager.dispose();
    });

    it('names, logs, and forwards language-server diagnostics', async () => {
        const manager = createLlgClientManager(context());
        await manager.start();
        const client = languageClientTestApi.__clients[0];
        const next = vi.fn();
        const uri = { toString: () => 'file:///tmp/top.sv' };
        const diagnostics = [{ source: 'llg-lint' }, { source: 'surelog' }];

        expect(client.options?.diagnosticCollectionName).toBe('Lapligence');
        client.options?.middleware?.handleDiagnostics?.(uri, diagnostics, next);

        expect(next).toHaveBeenCalledWith(uri, diagnostics);
        expect((vscode as typeof vscode & { __outputChannel: { appendLine: Mock } }).__outputChannel.appendLine)
            .toHaveBeenCalledWith(expect.stringContaining('lint_rules=1 total=2'));
        await manager.dispose();
    });

    it('forwards empty diagnostic publications without logging noise', async () => {
        const manager = createLlgClientManager(context());
        await manager.start();
        const client = languageClientTestApi.__clients[0];
        const next = vi.fn();
        const output = (vscode as typeof vscode & { __outputChannel: { appendLine: Mock } }).__outputChannel.appendLine;
        output.mockClear();

        client.options?.middleware?.handleDiagnostics?.({ toString: () => 'file:///tmp/top.sv' }, [], next);

        expect(next).toHaveBeenCalledOnce();
        expect(output).not.toHaveBeenCalled();
        await manager.dispose();
    });

    it('remembers MethodNotFound for the session and retries after a new server session', async () => {
        const manager = createLlgClientManager(context());
        await manager.start();
        const firstClient = languageClientTestApi.__clients[0];
        firstClient.sendRequest.mockRejectedValue({ code: -32601 });

        await expect(manager.getModuleExplorerSnapshot()).resolves.toBeUndefined();
        await expect(manager.getModuleExplorerSnapshot()).resolves.toBeUndefined();
        expect(firstClient.sendRequest).toHaveBeenCalledTimes(1);

        await manager.restart();
        const secondClient = languageClientTestApi.__clients[1];
        secondClient.sendRequest.mockResolvedValue({ roots: [], modules: [] });
        await expect(manager.getModuleExplorerSnapshot()).resolves.toEqual({ roots: [], modules: [] });
        expect(secondClient.sendRequest).toHaveBeenCalledTimes(1);
        await manager.dispose();
    });

    it('does not reuse a cached snapshot after stop and start', async () => {
        const manager = createLlgClientManager(context());
        await manager.start();
        const firstClient = languageClientTestApi.__clients[0];
        firstClient.sendRequest.mockResolvedValue({ roots: [], modules: [] });
        await manager.getModuleExplorerSnapshot();

        await manager.stop();
        await manager.start();
        const secondClient = languageClientTestApi.__clients[1];
        secondClient.sendRequest.mockResolvedValue({ roots: [], modules: [] });
        await manager.getModuleExplorerSnapshot();
        expect(firstClient.sendRequest).toHaveBeenCalledTimes(1);
        expect(secondClient.sendRequest).toHaveBeenCalledTimes(1);
        await manager.dispose();
    });
});

describe('nested llg.toml roots', () => {
    beforeEach(() => {
        languageClientTestApi.__clients.length = 0;
    });

    it('announces directories of nested llg.toml files as extra workspace folders', async () => {
        const workspace = vscode.workspace as unknown as {
            workspaceFolders: Array<{ uri: { fsPath: string }; name: string }>;
            findFiles: Mock;
        };
        workspace.workspaceFolders = [{ uri: { fsPath: '/ws' }, name: 'ws' }];
        workspace.findFiles.mockResolvedValueOnce([
            { fsPath: '/ws/llg.toml' },
            { fsPath: '/ws/ip/core/llg.toml' },
        ]);
        try {
            const manager = createLlgClientManager(context());
            await manager.start();
            const client = languageClientTestApi.__clients.at(-1) as unknown as {
                options: { initializationOptions: { llg: { configFiles: Array<{ workspaceUri: string; path: string }> } } };
                fillInitializeParams(params: { workspaceFolders?: Array<{ uri: string; name: string }> | null }): void;
            };
            expect(client.options.initializationOptions.llg.configFiles).toEqual([
                { workspaceUri: 'file:///ws', path: path.join('/ws', 'llg.toml') },
                { workspaceUri: 'file:///ws/ip/core', path: path.join('/ws/ip/core', 'llg.toml') },
            ]);
            const params: { workspaceFolders?: Array<{ uri: string; name: string }> | null } = {};
            client.fillInitializeParams(params);
            expect(params.workspaceFolders).toEqual([
                { uri: 'file:///ws', name: 'ws' },
                { uri: 'file:///ws/ip/core', name: 'core' },
            ]);
            await manager.dispose();
        } finally {
            workspace.workspaceFolders = [];
        }
    });
});
