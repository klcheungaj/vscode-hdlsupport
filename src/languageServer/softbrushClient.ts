import * as vscode from 'vscode';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { CloseAction, ErrorAction, LanguageClient, type ServerOptions, State } from 'vscode-languageclient/node';
import { resolveServerExecutable, validateExecutable } from './resolve';
import { CrashRestartTracker } from './restartPolicy';

const SECTION = 'hdlsupport.softbrush';
export const SOFTBRUSH_LANGUAGES = ['tcl', 'sdc', 'xdc'];
const IDENTITY = { name: 'Softbrush', binary: 'softbrush_ls', pathSetting: `${SECTION}.path` };

type SpawnServer = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Starts Softbrush without command-line arguments and exposes its stdio streams
 * to vscode-languageclient. Executable-form server options append `--stdio`,
 * which older Softbrush release binaries reject before LSP initialization.
 */
export function createSoftbrushServerOptions(
    executable: string,
    spawnServer: SpawnServer = spawn,
): ServerOptions {
    return () => new Promise<ChildProcess>((resolve, reject) => {
        const child = spawnServer(executable, [], {
            shell: false,
            stdio: 'pipe',
            windowsHide: true,
        });
        const onError = (error: Error): void => reject(error);
        child.once('error', onError);
        child.once('spawn', () => {
            child.off('error', onError);
            resolve(child);
        });
    });
}

/** Independent, serialized lifecycle; providers are registered by server capabilities. */
export function createSoftbrushClientManager(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Softbrush (Tcl/SDC/XDC)');
    const crashes = new CrashRestartTracker();
    let client: LanguageClient | undefined;
    let queue: Promise<unknown> = Promise.resolve();
    let disposed = false;
    let established = false;

    function enqueue(operation: () => Promise<void>): Promise<void> {
        const result = queue.then(operation, operation);
        queue = result.catch(() => undefined);
        return result;
    }

    async function stop(): Promise<void> {
        established = false;
        if (client) {
            await client.dispose();
            client = undefined;
        }
    }

    async function start(): Promise<void> {
        if (disposed || !vscode.workspace.getConfiguration(SECTION).get('enabled', true)) {
            return;
        }
        if (client && client.state !== State.Stopped) {
            return;
        }
        await stop();
        const resolved = resolveServerExecutable({
            settingPath: vscode.workspace.getConfiguration(SECTION).get('path', ''),
            platform: process.platform,
            arch: process.arch,
            extensionUri: context.extensionUri.fsPath,
        }, IDENTITY);
        if (resolved.kind === 'unsupported') {
            throw new Error(resolved.error);
        }
        const error = await validateExecutable(resolved.path, IDENTITY);
        if (error) { throw new Error(error); }
        crashes.reset();
        client = new LanguageClient(SECTION, 'Softbrush', createSoftbrushServerOptions(resolved.path), {
            documentSelector: SOFTBRUSH_LANGUAGES.map(language => ({ scheme: 'file', language })),
            outputChannel: output,
            diagnosticCollectionName: 'Softbrush',
            errorHandler: {
                error: (_error, _message, count) => ({
                    action: count !== undefined && count > 3 ? ErrorAction.Shutdown : ErrorAction.Continue,
                }),
                closed: () => {
                    if (disposed || !established) {
                        return { action: CloseAction.DoNotRestart, handled: true };
                    }
                    if (crashes.allowRestart(Date.now())) {
                        return { action: CloseAction.Restart, handled: true };
                    }
                    report(new Error('Softbrush crashed repeatedly. Check its output and run HDL Support: [Softbrush] Restart Language Server.'));
                    return { action: CloseAction.DoNotRestart, handled: true };
                },
            },
        });
        try {
            await client.start();
            established = true;
        } catch (error) {
            await stop();
            throw error;
        }
    }

    function report(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(message);
        void vscode.window.showErrorMessage(message);
    }

    const manager = {
        start: () => enqueue(start),
        stop: () => enqueue(stop),
        restart: () => enqueue(async () => { await stop(); await start(); }),
        dispose: () => enqueue(async () => { disposed = true; await stop(); output.dispose(); }),
    };
    let requested = false;
    const startForDocument = (document: vscode.TextDocument) => {
        if (document.uri.scheme === 'file' && SOFTBRUSH_LANGUAGES.includes(document.languageId) && !requested) {
            requested = true;
            void manager.start().catch(report);
        }
    };
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(startForDocument),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (requested && ['path', 'enabled'].some(key => event.affectsConfiguration(`${SECTION}.${key}`))) {
                void manager.restart().catch(report);
            }
        }),
        vscode.commands.registerCommand(`${SECTION}.restart`, () => { requested = true; return manager.restart().catch(report); }),
        vscode.commands.registerCommand(`${SECTION}.showOutput`, () => output.show()),
        { dispose: () => { void manager.dispose().catch(report); } },
    );
    vscode.workspace.textDocuments.forEach(startForDocument);
    return manager;
}
