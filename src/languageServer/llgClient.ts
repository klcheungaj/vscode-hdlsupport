import * as vscode from 'vscode';
import * as path from 'path';
import {
    CloseAction,
    ErrorAction,
    Executable,
    InitializeParams,
    LanguageClient,
    LanguageClientOptions,
    NotificationType,
    RenameRequest,
    ServerOptions,
    State,
    TransportKind,
} from 'vscode-languageclient/node';
import { buildInitializationOptions, effectiveConfigPath, WorkspaceFolderInfo } from './initOptions';
import { LLG_CONFIG_FILE, nestedConfigRoots } from './llgConfigDiscovery';
import { resolveServerExecutable, validateExecutable } from './resolve';
import { CrashRestartTracker, LaunchParamsSnapshot } from './restartPolicy';

const LLG_SECTION = 'hdlsupport.llg';
const LLG_CLIENT_ID = LLG_SECTION;
const LLG_CLIENT_NAME = 'Lapligence';
// Shared with commands.ts so user-facing messages always name the same channel.
export const LLG_OUTPUT_CHANNEL_NAME = 'Lapligence Language Server';
const RESTART_COMMAND = 'hdlsupport.llg.restart';
const DEFAULT_LOG_LEVEL = 'warn';
const MAX_TRANSIENT_CONNECTION_ERRORS = 3;
/** Opt-in environment flag used only by compiled desktop/host test fixtures. */
export const TEST_MODE_ENV = 'HDLSUPPORT_TEST_MODE';
/** Absolute CommonJS module passed to the current Node executable in test mode. */
export const TEST_SERVER_MODULE_ENV = 'HDLSUPPORT_TEST_SERVER_MODULE';
/** Parent Node executable used by desktop tests; extension-host execPath is Electron. */
export const TEST_NODE_EXECUTABLE_ENV = 'HDLSUPPORT_TEST_NODE_EXECUTABLE';
// Custom request served by the Lapligence (llg) server; result is `{ lines: string[] }`.
const DUMP_TOKENS_REQUEST = 'llg/dumpTokens';
// Custom request served by the Lapligence (llg) server; result is
// `{ ranges: [{ startLine, endLine }] }` (zero-based inclusive lines).
const INACTIVE_RANGES_REQUEST = 'llg/inactiveRanges';
// Custom request served by newer llg versions; result is the recursive
// module-hierarchy snapshot used by the HDL Modules explorer.
export const MODULE_EXPLORER_REQUEST = 'llg/moduleExplorer';
// Server→client notification pushed when an effective llg.toml reload
// changed backend state (e.g. `[compile] defines`). Empty params: the client
// refetches every config-derived view instead of trusting a stale delta.
const CONFIG_CHANGED_NOTIFICATION = new NotificationType('llg/configChanged');
// Server→client notification pushed after the module-explorer snapshot is
// replaced. Empty params: the client drops its cached snapshot and refetches.
export const MODULE_EXPLORER_CHANGED_NOTIFICATION = new NotificationType('llg/moduleExplorerChanged');

/** A zero-based range in the module-explorer wire payload. */
export interface LlgModuleExplorerRange {
    readonly startLine?: number;
    readonly startCharacter?: number;
    readonly endLine?: number;
    readonly endCharacter?: number;
    readonly start?: { readonly line?: number; readonly character?: number };
    readonly end?: { readonly line?: number; readonly character?: number };
}

/** Optional declaration location carried by a contents leaf. */
export interface LlgModuleExplorerLocation {
    readonly uri?: string | null;
    readonly targetUri?: string | null;
    readonly range?: LlgModuleExplorerRange | null;
    readonly targetRange?: LlgModuleExplorerRange | null;
    readonly targetSelectionRange?: LlgModuleExplorerRange | null;
}

/** Source of the declaration contents attached to a hierarchy entry. */
export type LlgModuleExplorerContentSource = 'elaborated' | 'declaration';

/** The typed declaration type used by module-explorer contents. */
export interface LlgModuleExplorerType {
    readonly kind?: string;
    readonly width?: number | null;
    readonly signed?: boolean;
    readonly typeName?: string | null;
    readonly resolvedWidth?: number | null;
    readonly packedWidth?: number | null;
    readonly resolvedRange?: string | null;
    readonly packedRange?: string | null;
    readonly packedDimension?: string | null;
    readonly range?: string | { readonly left?: string | number; readonly right?: string | number } | null;
    readonly displayType?: string | null;
    readonly resolvedDisplayType?: string | null;
}

/** A typed port in the module-explorer wire payload. */
export interface LlgModuleExplorerPort {
    readonly name: string;
    readonly direction?: string;
    /** Optional legacy/detail text fallback supplied by proxy servers. */
    readonly detail?: string | null;
    readonly type?: LlgModuleExplorerType;
    readonly resolvedDisplayType?: string | null;
    readonly resolvedTypeDisplay?: string | null;
    readonly displayType?: string | null;
    readonly typeDisplay?: string | null;
    readonly resolvedType?: string | LlgModuleExplorerType | null;
    readonly uri?: string | null;
    readonly range?: LlgModuleExplorerRange | null;
    readonly location?: LlgModuleExplorerLocation | null;
    readonly declarationLocation?: LlgModuleExplorerLocation | null;
    readonly sourceLocation?: LlgModuleExplorerLocation | null;
    readonly declarationUri?: string | null;
    readonly declarationRange?: LlgModuleExplorerRange | null;
    readonly sourceUri?: string | null;
    readonly sourceRange?: LlgModuleExplorerRange | null;
}

/** A typed signal in the module-explorer wire payload. */
export interface LlgModuleExplorerSignal {
    readonly name: string;
    readonly kind?: string;
    /** Optional legacy/detail text fallback supplied by proxy servers. */
    readonly detail?: string | null;
    readonly type?: LlgModuleExplorerType;
    readonly resolvedDisplayType?: string | null;
    readonly resolvedTypeDisplay?: string | null;
    readonly displayType?: string | null;
    readonly typeDisplay?: string | null;
    readonly resolvedType?: string | LlgModuleExplorerType | null;
    readonly uri?: string | null;
    readonly range?: LlgModuleExplorerRange | null;
    readonly location?: LlgModuleExplorerLocation | null;
    readonly declarationLocation?: LlgModuleExplorerLocation | null;
    readonly sourceLocation?: LlgModuleExplorerLocation | null;
    readonly declarationUri?: string | null;
    readonly declarationRange?: LlgModuleExplorerRange | null;
    readonly sourceUri?: string | null;
    readonly sourceRange?: LlgModuleExplorerRange | null;
}

/** A typed parameter in the module-explorer wire payload. */
export interface LlgModuleExplorerParameter {
    readonly name: string;
    /** Optional legacy/detail text fallback supplied by proxy servers. */
    readonly detail?: string | null;
    readonly type?: LlgModuleExplorerType;
    readonly value?: string | number | null;
    readonly resolvedValue?: string | number | null;
    readonly local?: boolean;
    readonly resolvedDisplayType?: string | null;
    readonly resolvedTypeDisplay?: string | null;
    readonly displayType?: string | null;
    readonly typeDisplay?: string | null;
    readonly resolvedType?: string | LlgModuleExplorerType | null;
    readonly uri?: string | null;
    readonly range?: LlgModuleExplorerRange | null;
    readonly location?: LlgModuleExplorerLocation | null;
    readonly declarationLocation?: LlgModuleExplorerLocation | null;
    readonly sourceLocation?: LlgModuleExplorerLocation | null;
    readonly declarationUri?: string | null;
    readonly declarationRange?: LlgModuleExplorerRange | null;
    readonly sourceUri?: string | null;
    readonly sourceRange?: LlgModuleExplorerRange | null;
}

/** One recursive instantiation instance in the module-explorer wire payload. */
export interface LlgModuleExplorerInstance {
    readonly id?: string | null;
    readonly instanceName?: string;
    readonly moduleType?: string;
    readonly definitionId?: string | null;
    readonly uri?: string | null;
    readonly range?: LlgModuleExplorerRange | null;
    readonly isUnresolvedGroup?: boolean;
    readonly contentSource?: LlgModuleExplorerContentSource;
    /** Additive compatibility spelling used by newer server snapshots. */
    readonly isAmbiguous?: boolean;
    readonly isAmbiguousDefinition?: boolean;
    readonly isCycleTruncated?: boolean;
    readonly isBudgetTruncated?: boolean;
    readonly ports?: readonly LlgModuleExplorerPort[];
    readonly params?: readonly LlgModuleExplorerParameter[];
    readonly signals?: readonly LlgModuleExplorerSignal[];
    readonly generatedScopes?: readonly LlgModuleExplorerGenerateScope[];
    readonly children: readonly LlgModuleExplorerInstance[];
}

/** One top-level module in the recursive module-explorer wire payload. */
export type LlgModuleExplorerRoot = LlgModuleExplorerInstance;

/** One generated scope in the module-explorer wire payload. */
export interface LlgModuleExplorerGenerateScope {
    readonly id?: string | null;
    readonly name: string;
    readonly params?: readonly LlgModuleExplorerParameter[];
    readonly contentSource?: LlgModuleExplorerContentSource;
    /** Additive compatibility spelling used by newer server snapshots. */
    readonly isAmbiguous?: boolean;
    readonly isAmbiguousDefinition?: boolean;
    readonly children: readonly LlgModuleExplorerInstance[];
    /** Nested source generate scopes remain explicit wrapper nodes. */
    readonly nestedScopes?: readonly LlgModuleExplorerGenerateScope[];
}

/** Module contents keyed by definition identity for the contents tree. */
export interface LlgModuleExplorerModule {
    readonly id?: string | null;
    readonly name: string;
    readonly uri?: string | null;
    readonly range?: LlgModuleExplorerRange | null;
    readonly ports?: readonly LlgModuleExplorerPort[];
    readonly params?: readonly LlgModuleExplorerParameter[];
    readonly signals?: readonly LlgModuleExplorerSignal[];
    readonly contentSource?: LlgModuleExplorerContentSource;
    /** Additive compatibility spelling used by newer server snapshots. */
    readonly isAmbiguous?: boolean;
    readonly isAmbiguousDefinition?: boolean;
}

/** Complete result of the `llg/moduleExplorer` request. */
export interface LlgModuleExplorerSnapshot {
    readonly roots: readonly LlgModuleExplorerRoot[];
    readonly modules?: readonly LlgModuleExplorerModule[];
}

/** One skipped conditional-compilation region: zero-based inclusive lines. */
export interface LlgInactiveRange {
    readonly startLine: number;
    readonly endLine: number;
}

/** Effective `llg.toml` path per folder, keyed by the same URI strings the
 *  initializationOptions use; shared by the launch snapshot and readLaunchParams. */
function buildConfigPaths(
    folders: WorkspaceFolderInfo[],
    configPathFor: (folderUri: string) => string,
): Record<string, string> {
    const configPaths: Record<string, string> = {};
    for (const folder of folders) {
        configPaths[folder.uri] = effectiveConfigPath(folder.uri, configPathFor(folder.uri));
    }
    return configPaths;
}

/** Reads the launch-relevant settings exactly as runStart() does, so callers can
 *  compare them against LlgClientManager.appliedLaunchParams by value. */
export function readLaunchParams(context: vscode.ExtensionContext): LaunchParamsSnapshot {
    const section = vscode.workspace.getConfiguration(LLG_SECTION);
    const resolved = resolveServerExecutable({
        settingPath: section.get<string>('path', ''),
        platform: process.platform,
        arch: process.arch,
        extensionUri: context.extensionUri.fsPath,
    });
    const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        uri: folder.uri.fsPath,
        name: folder.name,
    }));
    return {
        // An unresolvable server command can never equal an applied one, so a
        // restart attempt surfaces the actionable resolution error again.
        serverPath: resolved.kind === 'unsupported' ? '' : resolved.path,
        logLevel: section.get<string>('logLevel', DEFAULT_LOG_LEVEL),
        configPaths: buildConfigPaths(folders, (folderUri) =>
            vscode.workspace.getConfiguration(LLG_SECTION, vscode.Uri.file(folderUri)).get<string>('configPath', ''),
        ),
    };
}

export interface LlgClientManager {
    start(): Promise<void>;
    stop(): Promise<void>;
    restart(): Promise<void>;
    dispose(): Promise<void>;
    readonly outputChannel: vscode.OutputChannel;
    /** Launch parameters actually used by the most recent successful start;
     *  null until then. Compare with readLaunchParams() to decide whether a
     *  configuration change really requires a restart. */
    readonly appliedLaunchParams: LaunchParamsSnapshot | null;
    isRunning(): boolean;
    /** Sends the custom dump request; resolves with the server's lines (may be an error line). Rejects when the client isn't running. */
    dumpTokens(uri: string): Promise<string[]>;
    /** Sends the custom inactive-ranges request for one document; resolves with the server's skipped line ranges (empty when unknown). Rejects when the client isn't running. */
    getInactiveRanges(uri: string): Promise<LlgInactiveRange[]>;
    /**
     * Returns the server-owned recursive module hierarchy. The result is
     * cached for the current server session and invalidated by the server's
     * `llg/moduleExplorerChanged` notification. `undefined` means the server
     * is an older version that does not implement the request; callers should
     * use the standard-symbol fallback in that case.
     */
    getModuleExplorerSnapshot(): Promise<LlgModuleExplorerSnapshot | undefined>;
    /** Registers a callback fired when the server replaces its module
     * explorer snapshot. Handlers persist across server restarts. */
    onModuleExplorerChanged(handler: () => void): vscode.Disposable;
    /** Registers a callback fired when the server reports an effective
     *  llg.toml reload (`llg/configChanged` notification, e.g. a
     *  `[compile] defines` edit). Handlers persist across server restarts.
     *  Returns a disposable that unregisters the callback. */
    onConfigChanged(handler: () => void): vscode.Disposable;
}

const JSON_RPC_METHOD_NOT_FOUND = -32601;

/** True when an LSP request failed because the server does not know its method. */
export function isMethodNotFoundError(error: unknown): boolean {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        return (error as { code?: unknown }).code === JSON_RPC_METHOD_NOT_FOUND;
    }
    return error instanceof Error && error.message.toLowerCase().includes('method not found');
}

/**
 * Builds arguments for the executable launch without changing the production
 * LSP command line. Test mode is deliberately opt-in and requires the test
 * runner to provide an absolute module path.
 */
export function buildServerArguments(
    _executablePath: string,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string[] {
    if (environment[TEST_MODE_ENV] !== '1') {
        return [];
    }

    const modulePath = environment[TEST_SERVER_MODULE_ENV]?.trim();
    if (!modulePath || !path.isAbsolute(modulePath)) {
        throw new Error(
            `${TEST_MODE_ENV}=1 requires ${TEST_SERVER_MODULE_ENV} to contain an absolute fake-server module path.`,
        );
    }
    return [path.resolve(modulePath)];
}

/**
 * Selects the command used by the guarded test launch. The extension host can
 * report the VS Code Electron binary as process.execPath, so desktop runners
 * pass the parent Node executable explicitly.
 */
export function resolveServerCommand(
    executablePath: string,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
    if (environment[TEST_MODE_ENV] !== '1') {
        return executablePath;
    }
    const nodeExecutable = environment[TEST_NODE_EXECUTABLE_ENV]?.trim();
    if (!nodeExecutable || !path.isAbsolute(nodeExecutable)) {
        throw new Error(
            `${TEST_MODE_ENV}=1 requires ${TEST_NODE_EXECUTABLE_ENV} to contain an absolute parent Node executable path.`,
        );
    }
    return path.resolve(nodeExecutable);
}

// Directories never searched for nested llg.toml files.
const NESTED_CONFIG_EXCLUDE = '**/{.git,node_modules}/**';
// Trailing debounce for llg.toml create/delete and workspace-folder events.
const NESTED_ROOTS_REFRESH_MS = 500;

/**
 * The llg server analyzes one project per LSP workspace folder and ignores
 * `llg.toml` files below a folder. Every directory holding a nested
 * `llg.toml` is therefore announced as an extra workspace folder, so the
 * server owns each file by its closest `llg.toml` (longest-prefix root).
 */
class LlgLanguageClient extends LanguageClient {
    constructor(
        id: string,
        name: string,
        serverOptions: ServerOptions,
        clientOptions: LanguageClientOptions,
        private readonly nestedRoots: readonly string[],
    ) {
        super(id, name, serverOptions, clientOptions);
        // Rename is disabled client-side: ignore the server's renameProvider
        // capability so VS Code never registers a rename provider for llg.
        this.getFeature(RenameRequest.method).initialize = () => {};
    }

    protected fillInitializeParams(params: InitializeParams): void {
        super.fillInitializeParams(params);
        if (this.nestedRoots.length > 0 && params.workspaceFolders) {
            params.workspaceFolders = [
                ...params.workspaceFolders,
                ...this.nestedRoots.map((root) => ({
                    uri: vscode.Uri.file(root).toString(),
                    name: path.basename(root),
                })),
            ];
        }
    }
}

/** Directories of `llg.toml` files nested strictly inside workspace folders. */
async function discoverNestedRoots(folders: readonly WorkspaceFolderInfo[]): Promise<string[]> {
    const found = await Promise.all(folders.map((folder) => vscode.workspace.findFiles(
        new vscode.RelativePattern(vscode.Uri.file(folder.uri), `**/${LLG_CONFIG_FILE}`),
        NESTED_CONFIG_EXCLUDE,
    )));
    return nestedConfigRoots(folders.map((folder) => folder.uri), found.flat().map((uri) => uri.fsPath));
}

export function createLlgClientManager(context: vscode.ExtensionContext): LlgClientManager {
    const outputChannel = vscode.window.createOutputChannel(LLG_OUTPUT_CHANNEL_NAME);
    const crashTracker = new CrashRestartTracker();
    let client: LanguageClient | null = null;
    let sessionEstablished = false;
    let disposed = false;
    let appliedLaunchParams: LaunchParamsSnapshot | null = null;
    // Nested llg.toml roots announced to the running server.
    let appliedNestedRoots: readonly string[] = [];
    let nestedRootsTimer: ReturnType<typeof setTimeout> | undefined;
    let moduleExplorerSnapshot: LlgModuleExplorerSnapshot | undefined;
    let moduleExplorerRequest: Promise<LlgModuleExplorerSnapshot | undefined> | undefined;
    let moduleExplorerCacheGeneration = 0;
    let moduleExplorerUnsupported = false;

    // Single-tenant lifecycle queue (P2-1): every start/stop/restart/dispose
    // runs as ONE queued operation, so concurrent callers can never interleave
    // on `client`. Invariant: at most one LanguageClient/process is alive at
    // any time. restart() enqueues its stop→start pair as a single operation,
    // so a restart issued while the initial start is still running cannot
    // spawn a second server; it simply runs once that start has completed.
    let lifecycleQueue: Promise<unknown> = Promise.resolve();
    // Handlers fired when the running server pushes `llg/configChanged`;
    // re-attached to every LanguageClient instance on (re)start so they
    // survive automatic restarts.
    const configChangedHandlers = new Set<() => void>();
    // Handlers fired when the running server pushes a new module explorer
    // snapshot; re-attached to every LanguageClient instance on (re)start.
    const moduleExplorerChangedHandlers = new Set<() => void>();

    function clearModuleExplorerCache(): void {
        moduleExplorerSnapshot = undefined;
        moduleExplorerRequest = undefined;
        moduleExplorerCacheGeneration += 1;
    }

    function enqueueLifecycle<T>(operation: () => Promise<T>): () => Promise<T> {
        return async () => {
            const result = lifecycleQueue.then(operation, operation);
            // Keep the chain alive even when an operation fails; the caller
            // still observes the original rejection via `result`.
            lifecycleQueue = result.catch(() => undefined);
            return result;
        };
    }

    function log(message: string): void {
        outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    }

    function errorDetail(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    async function runStart(): Promise<void> {
        if (disposed) {
            throw new Error(`${LLG_CLIENT_NAME}: client manager is disposed`);
        }
        if (client !== null && client.state !== State.Stopped) {
            await client.start();
            return;
        }

        const settings = vscode.workspace.getConfiguration(LLG_SECTION);
        const logLevel = settings.get<string>('logLevel', DEFAULT_LOG_LEVEL);
        const resolved = resolveServerExecutable({
            settingPath: settings.get<string>('path', ''),
            platform: process.platform,
            arch: process.arch,
            extensionUri: context.extensionUri.fsPath,
        });
        if (resolved.kind === 'unsupported') {
            log(resolved.error);
            void vscode.window.showErrorMessage(resolved.error);
            throw new Error(resolved.error);
        }
        let serverCommand = resolved.path;
        let serverArgs: string[];
        try {
            serverCommand = resolveServerCommand(resolved.path);
            serverArgs = buildServerArguments(serverCommand);
        } catch (error) {
            const detail = errorDetail(error);
            log(detail);
            void vscode.window.showErrorMessage(detail);
            throw error instanceof Error ? error : new Error(detail);
        }
        const validationError = await validateExecutable(serverCommand);
        if (validationError !== null) {
            log(validationError);
            void vscode.window.showErrorMessage(validationError);
            throw new Error(validationError);
        }

        crashTracker.reset();
        sessionEstablished = false;
        clearModuleExplorerCache();
        moduleExplorerUnsupported = false;
        const serverOptions: Executable = {
            command: serverCommand,
            transport: TransportKind.stdio,
            ...(serverArgs.length > 0 ? { args: serverArgs } : {}),
            options: {
                env: {
                    ...process.env,
                    LLG_LOG: logLevel,
                },
            },
        };
        const workspaceFolderInfos = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
            uri: folder.uri.fsPath,
            name: folder.name,
        }));
        // Nested roots always use their own <dir>/llg.toml; configPath only
        // overrides a workspace folder's root config.
        const workspaceRootSet = new Set(workspaceFolderInfos.map((folder) => folder.uri));
        const configPathFor = (folderUri: string): string => workspaceRootSet.has(folderUri)
            ? vscode.workspace.getConfiguration(LLG_SECTION, vscode.Uri.file(folderUri)).get<string>('configPath', '')
            : '';
        const nestedRoots = await discoverNestedRoots(workspaceFolderInfos);
        if (nestedRoots.length > 0) {
            log(`nested llg.toml roots: ${nestedRoots.join(', ')}`);
        }
        const clientOptions: LanguageClientOptions = {
            documentSelector: [
                { scheme: 'file', language: 'verilog' },
                { scheme: 'file', language: 'systemverilog' },
            ],
            outputChannel,
            diagnosticCollectionName: LLG_CLIENT_NAME,
            middleware: {
                handleDiagnostics(uri, diagnostics, next) {
                    const lintCount = diagnostics.filter((diagnostic) => diagnostic.source === 'llg-lint').length;
                    if (diagnostics.length > 0) {
                        log(`received diagnostics uri=${uri.toString()} lint_rules=${lintCount} total=${diagnostics.length}`);
                    }
                    next(uri, diagnostics);
                },
            },
            initializationOptions: buildInitializationOptions(
                [...workspaceFolderInfos, ...nestedRoots.map((root) => ({ uri: root, name: path.basename(root) }))],
                configPathFor,
            ),
            errorHandler: {
                error(error, message, count) {
                    if (count !== undefined && count > MAX_TRANSIENT_CONNECTION_ERRORS) {
                        // Giving up silently is safe: the shutdown leads to
                        // closed(), which reports our own actionable message.
                        return { action: ErrorAction.Shutdown, handled: true };
                    }
                    log(`connection error${count !== undefined ? ` (count ${count})` : ''}: ${error.message}`);
                    // Transient hiccups are only logged; there is nothing to
                    // say to the user yet, so suppress the client's generic
                    // error dialog as well.
                    return { action: ErrorAction.Continue, handled: true };
                },
                closed() {
                    if (disposed || !sessionEstablished) {
                        // Either disposing (nothing worth reporting) or startup
                        // failed and runStart() already surfaced its own
                        // actionable error; suppress vscode-languageclient's
                        // generic "connection closed" dialog on top of it.
                        return { action: CloseAction.DoNotRestart, handled: true };
                    }
                    // vscode-languageclient may restart the same
                    // LanguageClient instance in place. Its next process has
                    // a different committed model, so discard this process's
                    // response before allowing that automatic restart.
                    clearModuleExplorerCache();
                    moduleExplorerUnsupported = false;
                    if (!crashTracker.allowRestart(Date.now())) {
                        const exhaustedMessage =
                            `The ${LLG_CLIENT_NAME} language server crashed repeatedly and automatic ` +
                            `restart was stopped. Check the '${LLG_OUTPUT_CHANNEL_NAME}' output channel ` +
                            `(${LLG_SECTION}.showOutput) for details, then run the ` +
                            `'${RESTART_COMMAND}' command to start it again.`;
                        log(exhaustedMessage);
                        void vscode.window.showErrorMessage(exhaustedMessage);
                        return { action: CloseAction.DoNotRestart, message: exhaustedMessage, handled: true };
                    }
                    log('server exited unexpectedly; restarting automatically');
                    return { action: CloseAction.Restart, handled: true };
                },
            },
        };

        const newClient = new LlgLanguageClient(LLG_CLIENT_ID, LLG_CLIENT_NAME, serverOptions, clientOptions, nestedRoots);
        client = newClient;
        // Register before start(): the client attaches stored notification
        // handlers when the connection opens, so nothing is missed even if
        // the server pushes during initialization.
        newClient.onNotification(CONFIG_CHANGED_NOTIFICATION, () => {
            log('server reported an effective llg.toml reload');
            for (const handler of [...configChangedHandlers]) {
                handler();
            }
        });
        newClient.onNotification(MODULE_EXPLORER_CHANGED_NOTIFICATION, () => {
            if (client !== newClient) {
                return;
            }
            clearModuleExplorerCache();
            log('server reported a new module explorer snapshot');
            for (const handler of [...moduleExplorerChangedHandlers]) {
                try {
                    handler();
                } catch (error) {
                    log(`module explorer refresh handler failed: ${errorDetail(error)}`);
                }
            }
        });
        log(`starting ${resolved.kind} server: ${serverCommand}`);
        try {
            await newClient.start();
        } catch (error) {
            const detail = `Failed to start the ${LLG_CLIENT_NAME} language server: ${errorDetail(error)}. ` +
                `See the '${LLG_OUTPUT_CHANNEL_NAME}' output channel for details.`;
            log(detail);
            void vscode.window.showErrorMessage(detail);
            throw error instanceof Error ? error : new Error(detail);
        }
        sessionEstablished = true;
        // Record exactly what this launch used so later configuration-change
        // events can be compared by value instead of restarting unconditionally.
        appliedLaunchParams = {
            serverPath: resolved.path,
            logLevel,
            configPaths: buildConfigPaths(workspaceFolderInfos, configPathFor),
        };
        appliedNestedRoots = nestedRoots;
        log('server started');
    }

    async function runStop(): Promise<void> {
        const current = client;
        client = null;
        sessionEstablished = false;
        crashTracker.reset();
        clearModuleExplorerCache();
        moduleExplorerUnsupported = false;
        if (current === null) {
            return;
        }
        try {
            await current.stop();
            log('server stopped');
        } catch (error) {
            log(`stopping the server failed: ${errorDetail(error)}`);
        }
    }

    async function runRestart(): Promise<void> {
        await runStop();
        await runStart();
    }

    /** Restart when the set of nested llg.toml roots no longer matches the
     *  roots the running server was started with. */
    async function runRefreshNestedRoots(): Promise<void> {
        if (disposed || client === null || !sessionEstablished) {
            return;
        }
        const folders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
            uri: folder.uri.fsPath,
            name: folder.name,
        }));
        const current = await discoverNestedRoots(folders);
        if (current.join('\0') === appliedNestedRoots.join('\0')) {
            return;
        }
        log('nested llg.toml roots changed; restarting the server');
        await runRestart();
    }

    const refreshNestedRoots = enqueueLifecycle(runRefreshNestedRoots);

    function scheduleNestedRootsRefresh(): void {
        if (nestedRootsTimer !== undefined) {
            clearTimeout(nestedRootsTimer);
        }
        nestedRootsTimer = setTimeout(() => {
            nestedRootsTimer = undefined;
            void refreshNestedRoots().catch((error: unknown) => {
                log(`refreshing nested llg.toml roots failed: ${errorDetail(error)}`);
            });
        }, NESTED_ROOTS_REFRESH_MS);
    }

    // Only creation/deletion changes the root set; content edits are
    // hot-reloaded by the server itself.
    const configWatcher = vscode.workspace.createFileSystemWatcher(`**/${LLG_CONFIG_FILE}`, false, true, false);
    context.subscriptions.push(
        configWatcher,
        configWatcher.onDidCreate(scheduleNestedRootsRefresh),
        configWatcher.onDidDelete(scheduleNestedRootsRefresh),
        vscode.workspace.onDidChangeWorkspaceFolders(scheduleNestedRootsRefresh),
    );

    async function runDispose(): Promise<void> {
        if (disposed) {
            return;
        }
        disposed = true;
        if (nestedRootsTimer !== undefined) {
            clearTimeout(nestedRootsTimer);
            nestedRootsTimer = undefined;
        }
        await runStop();
        configChangedHandlers.clear();
        moduleExplorerChangedHandlers.clear();
        outputChannel.dispose();
    }

    function isRunning(): boolean {
        return client !== null && client.state !== State.Stopped;
    }

    async function dumpTokens(uri: string): Promise<string[]> {
        const current = client;
        if (current === null || current.state === State.Stopped) {
            throw new Error(`The ${LLG_CLIENT_NAME} language server is not running.`);
        }
        const result: { lines?: string[] } = await current.sendRequest(DUMP_TOKENS_REQUEST, { uri });
        return result?.lines ?? [];
    }

    async function getInactiveRanges(uri: string): Promise<LlgInactiveRange[]> {
        const current = client;
        if (current === null || current.state === State.Stopped) {
            throw new Error(`The ${LLG_CLIENT_NAME} language server is not running.`);
        }
        const result: { ranges?: LlgInactiveRange[] } = await current.sendRequest(
            INACTIVE_RANGES_REQUEST,
            { uri },
        );
        return result?.ranges ?? [];
    }

    async function getModuleExplorerSnapshot(): Promise<LlgModuleExplorerSnapshot | undefined> {
        const current = client;
        if (current === null || current.state === State.Stopped) {
            throw new Error(`The ${LLG_CLIENT_NAME} language server is not running.`);
        }
        if (moduleExplorerUnsupported) {
            return undefined;
        }
        if (moduleExplorerSnapshot !== undefined) {
            return moduleExplorerSnapshot;
        }
        if (moduleExplorerRequest !== undefined) {
            return moduleExplorerRequest;
        }

        const generation = moduleExplorerCacheGeneration;
        const request = current
            .sendRequest<LlgModuleExplorerSnapshot>(MODULE_EXPLORER_REQUEST, {})
            .then((snapshot) => {
                // A notification or lifecycle transition may have invalidated
                // this response while it was in flight. Never repopulate the
                // newer generation with an older snapshot.
                if (generation === moduleExplorerCacheGeneration && client === current) {
                    moduleExplorerSnapshot = snapshot;
                }
                return snapshot;
            })
            .catch((error: unknown) => {
                if (isMethodNotFoundError(error)) {
                    // Older bundled/external servers remain usable through the
                    // pre-snapshot workspace/document-symbol path. Remember
                    // this for the session so every refresh does not repeat a
                    // request that can never succeed.
                    if (client === current) {
                        moduleExplorerUnsupported = true;
                    }
                    return undefined;
                }
                throw error;
            })
            .finally(() => {
                if (moduleExplorerRequest === request) {
                    moduleExplorerRequest = undefined;
                }
            });
        moduleExplorerRequest = request;
        return request;
    }

    function onModuleExplorerChanged(handler: () => void): vscode.Disposable {
        moduleExplorerChangedHandlers.add(handler);
        return new vscode.Disposable(() => {
            moduleExplorerChangedHandlers.delete(handler);
        });
    }

    function onConfigChanged(handler: () => void): vscode.Disposable {
        configChangedHandlers.add(handler);
        return new vscode.Disposable(() => {
            configChangedHandlers.delete(handler);
        });
    }

    // Public surface: unchanged signatures, but every lifecycle call is
    // serialized through the single-tenant queue above.
    return {
        outputChannel,
        get appliedLaunchParams() {
            return appliedLaunchParams;
        },
        start: enqueueLifecycle(runStart),
        stop: enqueueLifecycle(runStop),
        restart: enqueueLifecycle(runRestart),
        dispose: enqueueLifecycle(runDispose),
        isRunning,
        dumpTokens,
        getInactiveRanges,
        getModuleExplorerSnapshot,
        onModuleExplorerChanged,
        onConfigChanged,
    };
}
