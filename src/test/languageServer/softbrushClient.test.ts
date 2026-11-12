// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

vi.mock('vscode', () => {
    class Disposable {
        constructor(private readonly onDispose: () => void = () => undefined) {}

        dispose(): void {
            this.onDispose();
        }
    }

    type Document = { uri: { scheme: string }; languageId: string };
    type ConfigurationEvent = { affectsConfiguration(section: string): boolean };

    const settings: Record<string, unknown> = { enabled: true, path: '' };
    const textDocuments: Document[] = [];
    const openHandlers: Array<(document: Document) => void> = [];
    const configurationHandlers: Array<(event: ConfigurationEvent) => void> = [];
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    const outputChannel = {
        appendLine: vi.fn(),
        dispose: vi.fn(),
        show: vi.fn(),
    };

    return {
        window: {
            createOutputChannel: vi.fn(() => outputChannel),
            showErrorMessage: vi.fn(),
        },
        workspace: {
            textDocuments,
            getConfiguration: vi.fn(() => ({
                get: (key: string, fallback: unknown) => settings[key] ?? fallback,
            })),
            onDidOpenTextDocument: vi.fn((handler: (document: Document) => void) => {
                openHandlers.push(handler);
                return new Disposable();
            }),
            onDidChangeConfiguration: vi.fn((handler: (event: ConfigurationEvent) => void) => {
                configurationHandlers.push(handler);
                return new Disposable();
            }),
        },
        commands: {
            registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => unknown) => {
                commands.set(command, handler);
                return new Disposable(() => commands.delete(command));
            }),
        },
        __settings: settings,
        __textDocuments: textDocuments,
        __outputChannel: outputChannel,
        __openDocument: (document: Document) => openHandlers.forEach(handler => handler(document)),
        __changeConfiguration: (...affected: string[]) => {
            const event = { affectsConfiguration: (section: string) => affected.includes(section) };
            configurationHandlers.forEach(handler => handler(event));
        },
        __executeCommand: (command: string) => commands.get(command)?.(),
        __reset: () => {
            settings.enabled = true;
            settings.path = '';
            textDocuments.length = 0;
            openHandlers.length = 0;
            configurationHandlers.length = 0;
            commands.clear();
        },
    };
});

vi.mock('vscode-languageclient/node', () => {
    type StartBehavior = () => Promise<void>;
    const clients: FakeLanguageClient[] = [];
    const lifecycle: string[] = [];
    const startBehaviors: StartBehavior[] = [];

    class FakeLanguageClient {
        readonly index = clients.length;
        state = 1;
        readonly start = vi.fn(async () => {
            lifecycle.push(`start:${this.index}`);
            const behavior = startBehaviors.shift();
            if (behavior) {
                await behavior();
            }
            this.state = 2;
        });
        readonly dispose = vi.fn(async () => {
            lifecycle.push(`dispose:${this.index}`);
            this.state = 1;
        });

        constructor(
            readonly id: string,
            readonly name: string,
            readonly serverOptions: Record<string, unknown>,
            readonly options: Record<string, unknown>,
        ) {
            clients.push(this);
        }
    }

    return {
        CloseAction: { DoNotRestart: 0, Restart: 1 },
        ErrorAction: { Continue: 0, Shutdown: 1 },
        LanguageClient: FakeLanguageClient,
        State: { Stopped: 1, Running: 2 },
        TransportKind: { stdio: 0 },
        __clients: clients,
        __lifecycle: lifecycle,
        __startBehaviors: startBehaviors,
        __reset: () => {
            clients.length = 0;
            lifecycle.length = 0;
            startBehaviors.length = 0;
        },
    };
});

vi.mock('../../languageServer/resolve', () => ({
    resolveServerExecutable: vi.fn(() => ({ kind: 'path', path: '/extension/server/linux-x64/softbrush_ls' })),
    validateExecutable: vi.fn(async () => null),
}));

import * as vscode from 'vscode';
import * as languageClient from 'vscode-languageclient/node';
import { resolveServerExecutable, validateExecutable } from '../../languageServer/resolve';
import {
    createSoftbrushClientManager,
    createSoftbrushServerOptions,
    SOFTBRUSH_LANGUAGES,
} from '../../languageServer/softbrushClient';

interface TestDocument {
    uri: { scheme: string };
    languageId: string;
}

interface TestLanguageClient {
    id: string;
    name: string;
    state: number;
    serverOptions: unknown;
    options: {
        documentSelector?: Array<{ scheme: string; language: string }>;
        diagnosticCollectionName?: string;
        errorHandler?: {
            error(error: Error, message: unknown, count?: number): { action: number };
            closed(): { action: number; handled: boolean };
        };
    };
    start: Mock;
    dispose: Mock;
}

const vscodeTestApi = vscode as typeof vscode & {
    __settings: Record<string, unknown>;
    __textDocuments: TestDocument[];
    __outputChannel: { appendLine: Mock; dispose: Mock; show: Mock };
    __openDocument(document: TestDocument): void;
    __changeConfiguration(...affected: string[]): void;
    __executeCommand(command: string): unknown;
    __reset(): void;
};

const languageClientTestApi = languageClient as typeof languageClient & {
    __clients: TestLanguageClient[];
    __lifecycle: string[];
    __startBehaviors: Array<() => Promise<void>>;
    __reset(): void;
};

function context(): vscode.ExtensionContext {
    return {
        extensionUri: { fsPath: '/extension' },
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

function document(languageId: string, scheme = 'file'): TestDocument {
    return { languageId, uri: { scheme } };
}

async function waitForClientCount(count: number): Promise<void> {
    await vi.waitFor(() => expect(languageClientTestApi.__clients).toHaveLength(count));
}

describe('SoftbrushClientManager', () => {
    beforeEach(() => {
        vscodeTestApi.__reset();
        languageClientTestApi.__reset();
        vi.clearAllMocks();
    });

    it('starts lazily only for file-backed Tcl, SDC, and XDC documents', async () => {
        const manager = createSoftbrushClientManager(context());

        expect(languageClientTestApi.__clients).toHaveLength(0);
        vscodeTestApi.__openDocument(document('verilog'));
        vscodeTestApi.__openDocument(document('tcl', 'untitled'));
        await Promise.resolve();
        expect(languageClientTestApi.__clients).toHaveLength(0);

        vscodeTestApi.__openDocument(document('sdc'));
        await waitForClientCount(1);
        await vi.waitFor(() => expect(languageClientTestApi.__clients[0].start).toHaveBeenCalledOnce());

        vscodeTestApi.__openDocument(document('tcl'));
        vscodeTestApi.__openDocument(document('xdc'));
        await Promise.resolve();
        expect(languageClientTestApi.__clients).toHaveLength(1);
        await manager.dispose();
    });

    it('starts for an already-open supported document and configures all three selectors', async () => {
        vscodeTestApi.__textDocuments.push(document('xdc'));

        const manager = createSoftbrushClientManager(context());
        await waitForClientCount(1);
        const client = languageClientTestApi.__clients[0];

        expect(SOFTBRUSH_LANGUAGES).toEqual(['tcl', 'sdc', 'xdc']);
        expect(client.id).toBe('hdlsupport.softbrush');
        expect(client.name).toBe('Softbrush');
        expect(client.serverOptions).toEqual(expect.any(Function));
        expect(client.options.documentSelector).toEqual([
            { scheme: 'file', language: 'tcl' },
            { scheme: 'file', language: 'sdc' },
            { scheme: 'file', language: 'xdc' },
        ]);
        expect(client.options.diagnosticCollectionName).toBe('Softbrush');
        expect(resolveServerExecutable).toHaveBeenCalledWith({
            settingPath: '',
            platform: process.platform,
            arch: process.arch,
            extensionUri: '/extension',
        }, {
            name: 'Softbrush',
            binary: 'softbrush_ls',
            pathSetting: 'hdlsupport.softbrush.path',
        });
        expect(validateExecutable).toHaveBeenCalledWith(
            '/extension/server/linux-x64/softbrush_ls',
            expect.objectContaining({ binary: 'softbrush_ls' }),
        );
        await manager.dispose();
    });

    it('spawns Softbrush over stdio without command-line arguments', async () => {
        const child = new EventEmitter() as ChildProcess;
        const spawnServer = vi.fn(() => {
            queueMicrotask(() => child.emit('spawn'));
            return child;
        });
        const serverOptions = createSoftbrushServerOptions('/opt/softbrush_ls', spawnServer);

        expect(serverOptions).toEqual(expect.any(Function));
        await expect((serverOptions as () => Promise<ChildProcess>)()).resolves.toBe(child);
        expect(spawnServer).toHaveBeenCalledWith('/opt/softbrush_ls', [], {
            shell: false,
            stdio: 'pipe',
            windowsHide: true,
        });
    });

    it('rejects promptly when the Softbrush process cannot be spawned', async () => {
        const missingCommand = `hdlsupport-softbrush-missing-${process.pid}-${Date.now()}`;
        const serverOptions = createSoftbrushServerOptions(missingCommand);

        await expect((serverOptions as () => Promise<ChildProcess>)()).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('stays stopped while disabled and restarts after disable and re-enable', async () => {
        vscodeTestApi.__settings.enabled = false;
        vscodeTestApi.__textDocuments.push(document('tcl'));
        const manager = createSoftbrushClientManager(context());
        await Promise.resolve();
        expect(languageClientTestApi.__clients).toHaveLength(0);

        vscodeTestApi.__settings.enabled = true;
        vscodeTestApi.__changeConfiguration('hdlsupport.softbrush.enabled');
        await waitForClientCount(1);

        vscodeTestApi.__settings.enabled = false;
        vscodeTestApi.__changeConfiguration('hdlsupport.softbrush.enabled');
        await vi.waitFor(() => expect(languageClientTestApi.__clients[0].dispose).toHaveBeenCalledOnce());

        vscodeTestApi.__settings.enabled = true;
        vscodeTestApi.__changeConfiguration('hdlsupport.softbrush.enabled');
        await waitForClientCount(2);
        expect(languageClientTestApi.__clients[1].start).toHaveBeenCalledOnce();
        await manager.dispose();
    });

    it('ignores unrelated configuration changes and restarts when the path changes', async () => {
        const manager = createSoftbrushClientManager(context());
        vscodeTestApi.__openDocument(document('tcl'));
        await waitForClientCount(1);

        vscodeTestApi.__changeConfiguration('editor.fontSize');
        await Promise.resolve();
        expect(languageClientTestApi.__clients).toHaveLength(1);

        vscodeTestApi.__settings.path = '/opt/softbrush_ls';
        vscodeTestApi.__changeConfiguration('hdlsupport.softbrush.path');
        await waitForClientCount(2);
        expect(languageClientTestApi.__clients[0].dispose).toHaveBeenCalledOnce();
        expect(resolveServerExecutable).toHaveBeenLastCalledWith(
            expect.objectContaining({ settingPath: '/opt/softbrush_ls' }),
            expect.any(Object),
        );
        await manager.dispose();
    });

    it('serializes overlapping start, restart, stop, and dispose requests', async () => {
        let releaseStart!: () => void;
        const blockedStart = new Promise<void>(resolve => { releaseStart = resolve; });
        languageClientTestApi.__startBehaviors.push(() => blockedStart);
        const manager = createSoftbrushClientManager(context());

        const starting = manager.start();
        const restarting = manager.restart();
        const stopping = manager.stop();
        const disposing = manager.dispose();
        await waitForClientCount(1);
        expect(languageClientTestApi.__lifecycle).toEqual(['start:0']);

        releaseStart();
        await Promise.all([starting, restarting, stopping, disposing]);

        expect(languageClientTestApi.__lifecycle).toEqual([
            'start:0',
            'dispose:0',
            'start:1',
            'dispose:1',
        ]);
        expect(vscodeTestApi.__outputChannel.dispose).toHaveBeenCalledOnce();
        await manager.start();
        expect(languageClientTestApi.__clients).toHaveLength(2);
    });

    it('cleans up a failed client start and allows an explicit retry', async () => {
        languageClientTestApi.__startBehaviors.push(async () => {
            throw new Error('server failed during initialize');
        });
        const manager = createSoftbrushClientManager(context());

        await expect(manager.start()).rejects.toThrow('server failed during initialize');
        expect(languageClientTestApi.__clients[0].dispose).toHaveBeenCalledOnce();

        await expect(manager.start()).resolves.toBeUndefined();
        expect(languageClientTestApi.__clients).toHaveLength(2);
        expect(languageClientTestApi.__clients[1].start).toHaveBeenCalledOnce();
        await manager.dispose();
    });

    it('reports lazy startup failures through the Softbrush output and VS Code notification', async () => {
        languageClientTestApi.__startBehaviors.push(async () => {
            throw new Error('cannot initialize Softbrush');
        });
        const manager = createSoftbrushClientManager(context());

        vscodeTestApi.__openDocument(document('xdc'));
        await vi.waitFor(() => {
            expect(vscodeTestApi.__outputChannel.appendLine).toHaveBeenCalledWith('cannot initialize Softbrush');
        });
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('cannot initialize Softbrush');
        await manager.dispose();
    });

    it('bounds repeated crash restarts and shuts down after repeated protocol errors', async () => {
        const manager = createSoftbrushClientManager(context());
        await manager.start();
        const errorHandler = languageClientTestApi.__clients[0].options.errorHandler;
        expect(errorHandler).toBeDefined();

        expect(errorHandler?.error(new Error('wire error'), undefined, 3)).toEqual({ action: 0 });
        expect(errorHandler?.error(new Error('wire error'), undefined, 4)).toEqual({ action: 1 });
        for (let crash = 0; crash < 4; crash++) {
            expect(errorHandler?.closed()).toEqual({ action: 1, handled: true });
        }
        expect(errorHandler?.closed()).toEqual({ action: 0, handled: true });
        expect(vscodeTestApi.__outputChannel.appendLine)
            .toHaveBeenCalledWith(expect.stringContaining('Softbrush crashed repeatedly'));
        expect(vscode.window.showErrorMessage)
            .toHaveBeenCalledWith(expect.stringContaining('Softbrush crashed repeatedly'));
        await manager.dispose();
    });

    it('does not restart for a close before startup establishes the session', async () => {
        let releaseStart!: () => void;
        languageClientTestApi.__startBehaviors.push(() => new Promise<void>(resolve => { releaseStart = resolve; }));
        const manager = createSoftbrushClientManager(context());
        const starting = manager.start();
        await waitForClientCount(1);

        expect(languageClientTestApi.__clients[0].options.errorHandler?.closed())
            .toEqual({ action: 0, handled: true });
        releaseStart();
        await starting;
        await manager.dispose();
    });

    it('registers restart and output commands', async () => {
        const manager = createSoftbrushClientManager(context());

        expect(vscodeTestApi.__executeCommand('hdlsupport.softbrush.showOutput')).toBeUndefined();
        expect(vscodeTestApi.__outputChannel.show).toHaveBeenCalledOnce();

        await vscodeTestApi.__executeCommand('hdlsupport.softbrush.restart');
        expect(languageClientTestApi.__clients).toHaveLength(1);
        await manager.dispose();
    });
});
