#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Standalone fake `llg` language server used by the @vscode/test-electron
 * client-host suite. Behavior is controlled through the environment plus a
 * mode file so tests can flip behaviors between server launches:
 *
 *   LLG_FAKE_RECORD       absolute path; the raw `initialize` params are
 *                          written here as JSON on every launch.
 *   LLG_FAKE_CONTROL_DIR  directory holding control files:
 *                            mode          '' | 'normal' | 'hang' | 'crash:N'
 *                                          ('crash' alone means always)
 *                            server.pid    pid written on every launch
 *                            launches.log  one line appended per launch
 *                            fake-server.log diagnostic events from this process
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const RECORD_PATH: string = process.env.LLG_FAKE_RECORD ?? '';
const CONTROL_DIR: string = process.env.LLG_FAKE_CONTROL_DIR ?? '';
const LOG_PATH: string = process.env.LLG_FAKE_LOG ??
    (CONTROL_DIR === '' ? '' : path.join(CONTROL_DIR, 'fake-server.log'));

interface IncomingMessage {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: unknown;
}

interface RecordValue {
    [key: string]: unknown;
}

interface ExplorerRange {
    readonly startLine: number;
    readonly startCharacter: number;
    readonly endLine: number;
    readonly endCharacter: number;
}

interface ExplorerLocation {
    readonly uri: string;
    readonly range: ExplorerRange;
}

interface ExplorerType {
    readonly kind: string;
    readonly width: number;
    readonly signed: boolean;
    readonly typeName: string | null;
    readonly displayType: string;
}

interface ExplorerContentOptions {
    readonly detail?: string;
    readonly displayType?: string;
    readonly location?: ExplorerLocation;
}

type Mode = { kind: 'normal' } | { kind: 'hang' } | { kind: 'crash'; remaining: number };

const MODULE_EXPLORER_REQUEST = 'llg/moduleExplorer';
const MODULE_EXPLORER_CHANGED_NOTIFICATION = 'llg/moduleExplorerChanged';

function controlFile(name: string): string | null {
    return CONTROL_DIR !== '' ? path.join(CONTROL_DIR, name) : null;
}

function appendLog(message: string): void {
    if (LOG_PATH === '') {
        return;
    }
    try {
        fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
        fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // Diagnostics must never interfere with the stdio protocol.
    }
}

function appendLaunch(): void {
    appendLog(`launch pid=${process.pid} module=${JSON.stringify(process.argv[1] ?? '')}`);
    const launches = controlFile('launches.log');
    if (launches !== null) {
        fs.appendFileSync(launches, `${process.pid} ${new Date().toISOString()}\n`);
    }
    const pidFile = controlFile('server.pid');
    if (pidFile !== null) {
        fs.writeFileSync(pidFile, String(process.pid));
    }
}

function currentMode(): Mode {
    const modeFile = controlFile('mode');
    if (modeFile === null || !fs.existsSync(modeFile)) {
        return { kind: 'normal' };
    }
    const text = fs.readFileSync(modeFile, 'utf8').trim();
    if (text === 'hang') {
        return { kind: 'hang' };
    }
    const match = /^crash(?::(\d+))?$/.exec(text);
    if (match !== null) {
        const remaining = match[1] === undefined ? Number.MAX_SAFE_INTEGER : Number.parseInt(match[1], 10);
        if (!Number.isFinite(remaining)) {
            return { kind: 'crash', remaining };
        }
        if (remaining <= 0) {
            return { kind: 'normal' };
        }
        fs.writeFileSync(modeFile, `crash:${remaining - 1}`);
        return { kind: 'crash', remaining };
    }
    return { kind: 'normal' };
}

function recordInitialize(params: unknown): void {
    appendLog('received initialize');
    if (RECORD_PATH === '') {
        return;
    }
    fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true });
    fs.writeFileSync(RECORD_PATH, `${JSON.stringify(params, null, 2)}\n`);
}

function asRecord(value: unknown): RecordValue {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue
        : {};
}

function workspaceUriFromInitialize(params: unknown): string | undefined {
    const workspaceFolders = asRecord(params).workspaceFolders;
    if (Array.isArray(workspaceFolders)) {
        const uri = asRecord(workspaceFolders[0]).uri;
        if (typeof uri === 'string' && uri.length > 0) {
            return uri;
        }
    }
    const llg = asRecord(asRecord(params).initializationOptions).llg;
    const configFiles = asRecord(llg).configFiles;
    if (Array.isArray(configFiles)) {
        const uri = asRecord(configFiles[0]).workspaceUri;
        if (typeof uri === 'string' && uri.length > 0) {
            return uri;
        }
    }
    return undefined;
}

function workspaceFileUri(params: unknown, fileName: string): string {
    const workspaceUri = workspaceUriFromInitialize(params);
    if (workspaceUri === undefined) {
        return `file:///hdlsupport-e2e/${fileName}`;
    }
    try {
        return pathToFileURL(path.join(fileURLToPath(workspaceUri), fileName)).href;
    } catch {
        return `${workspaceUri.replace(/\/$/, '')}/${fileName}`;
    }
}

function explorerRange(startLine: number, startCharacter: number, endLine: number, endCharacter: number): ExplorerRange {
    return { startLine, startCharacter, endLine, endCharacter };
}

function sourceFields(location?: ExplorerLocation): RecordValue {
    return location === undefined ? {} : { uri: location.uri, range: location.range };
}

function contentLocationFields(location?: ExplorerLocation): RecordValue {
    return location === undefined ? {} : { location };
}

function explorerType(
    kind: string,
    width = 1,
    signed = false,
    typeName: string | null = null,
    displayType = kind === 'logic' || kind === 'bit' || kind === 'reg'
        ? width > 1 ? `${kind} [${width - 1}:0]` : kind
        : kind,
): ExplorerType {
    return { kind, width, signed, typeName, displayType };
}

function explorerPort(
    name: string,
    direction: string,
    kind = 'logic',
    width = 1,
    options: ExplorerContentOptions = {},
): RecordValue {
    return {
        name,
        direction,
        type: explorerType(kind, width, false, null, options.displayType),
        ...(options.detail === undefined ? {} : { detail: options.detail }),
        ...contentLocationFields(options.location),
    };
}

function explorerSignal(
    name: string,
    kind: string,
    typeKind = 'logic',
    width = 1,
    options: ExplorerContentOptions = {},
): RecordValue {
    return {
        name,
        kind,
        type: explorerType(typeKind, width, false, null, options.displayType),
        ...(options.detail === undefined ? {} : { detail: options.detail }),
        ...contentLocationFields(options.location),
    };
}

function explorerParameter(name: string, value: string, options: ExplorerContentOptions = {}): RecordValue {
    return {
        name,
        type: explorerType('int', 32, true, null, options.displayType ?? 'int'),
        value,
        local: false,
        ...(options.detail === undefined ? {} : { detail: options.detail }),
        ...contentLocationFields(options.location),
    };
}

function recordExplorerSnapshot(snapshot: RecordValue): void {
    appendLog('served module explorer snapshot');
    const snapshotPath = controlFile('module-explorer.json');
    if (snapshotPath !== null) {
        fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
}

/**
 * Deterministic snapshot used by the client-host suite. The shape mirrors
 * lapligence/src/bin/llg_ls/module_explorer.rs, while the URIs follow the temporary
 * workspace supplied in initialize so normal reveal/selection paths remain
 * realistic.
 */
function moduleExplorerSnapshot(params: unknown): RecordValue {
    const topUri = workspaceFileUri(params, 'top.sv');
    const childUri = workspaceFileUri(params, 'child.sv');
    const leafUri = workspaceFileUri(params, 'leaf.sv');
    const declarationAUri = workspaceFileUri(params, 'declaration-a.sv');
    const declarationBUri = workspaceFileUri(params, 'declaration-b.sv');

    // These are zero-based LSP ranges. Declaration locations point at the
    // identifier in the real host fixture; instance locations point at the
    // corresponding instantiation identifier in top.sv.
    const topModuleLocation: ExplorerLocation = {
        uri: topUri,
        range: explorerRange(0, 7, 0, 10),
    };
    const childModuleLocation: ExplorerLocation = {
        uri: childUri,
        range: explorerRange(0, 7, 0, 12),
    };
    const childClockLocation: ExplorerLocation = {
        uri: childUri,
        range: explorerRange(3, 30, 3, 33),
    };
    const childDataLocation: ExplorerLocation = {
        uri: childUri,
        range: explorerRange(4, 29, 4, 33),
    };
    const childLaneLocation: ExplorerLocation = {
        uri: childUri,
        range: explorerRange(5, 29, 5, 33),
    };
    const childWidthLocation: ExplorerLocation = {
        uri: childUri,
        range: explorerRange(1, 18, 1, 23),
    };
    const childSignalLocation: ExplorerLocation = {
        uri: childUri,
        range: explorerRange(8, 22, 8, 32),
    };
    const childSmallInstanceLocation: ExplorerLocation = {
        uri: topUri,
        range: explorerRange(6, 14, 6, 27),
    };
    const childWideInstanceLocation: ExplorerLocation = {
        uri: topUri,
        range: explorerRange(10, 14, 10, 27),
    };
    const topUnusedSignalLocation: ExplorerLocation = {
        uri: topUri,
        range: explorerRange(4, 10, 4, 20),
    };
    const leafLocation: ExplorerLocation = {
        uri: leafUri,
        range: explorerRange(0, 0, 4, 0),
    };

    const childPorts = (dataWidth: number): RecordValue[] => [
        explorerPort('clk', 'input', 'logic', 1, {
            // Repeated spaces and a trailing declaration name are intentional:
            // the client must normalize them before displaying the entry.
            detail: 'input    logic clk',
            location: childClockLocation,
            displayType: 'logic',
        }),
        explorerPort('data', 'output', 'logic', dataWidth, {
            detail: `output    logic [${dataWidth - 1}:0] data`,
            location: childDataLocation,
            displayType: `logic [${dataWidth - 1}:0]`,
        }),
        explorerPort('lane', 'output', 'logic', 2, {
            // Keep the packed range tight so `[1:0]` cannot regress to
            // `[ 1:0]` while whitespace is being normalized.
            detail: 'output    logic [1:0] lane',
            location: childLaneLocation,
            displayType: 'logic [1:0]',
        }),
    ];

    const childSignals = (dataWidth: number): RecordValue[] => [
        explorerSignal('unused_sig', 'var', 'logic', dataWidth, {
            detail: `logic    [${dataWidth - 1}:0] unused_sig`,
            location: childSignalLocation,
            displayType: `logic [${dataWidth - 1}:0]`,
        }),
    ];

    const topModule = {
        id: 'module:fake:top',
        name: 'top',
        ...sourceFields(topModuleLocation),
        contentSource: 'elaborated',
        ports: [
            explorerPort('clk', 'input', 'logic', 1, {
                detail: 'input    logic clk',
                location: topModuleLocation,
                displayType: 'logic',
            }),
            explorerPort('rst_n', 'input', 'logic', 1, {
                detail: 'input    logic rst_n',
                location: topModuleLocation,
                displayType: 'logic',
            }),
        ],
        params: [],
        signals: [explorerSignal('unused_sig', 'var', 'logic', 1, {
            detail: 'logic    unused_sig',
            location: topUnusedSignalLocation,
        })],
    };
    const childModule = {
        id: 'module:fake:child',
        name: 'child',
        ...sourceFields(childModuleLocation),
        contentSource: 'elaborated',
        ports: childPorts(8),
        params: [explorerParameter('WIDTH', '8', { location: childWidthLocation })],
        signals: childSignals(8),
    };
    const leafModule = {
        id: 'module:fake:leaf',
        name: 'leaf',
        ...sourceFields(leafLocation),
        contentSource: 'elaborated',
        ports: [explorerPort('data', 'input', 'logic', 8, {
            detail: 'input    logic [7:0] data',
            location: leafLocation,
            displayType: 'logic [7:0]',
        })],
        params: [],
        signals: [explorerSignal('leaf_state', 'var', 'bit', 1, {
            detail: 'bit leaf_state',
            location: leafLocation,
            displayType: 'bit',
        })],
    };
    const secondModule = {
        id: 'module:fake:second',
        name: 'second',
        ...sourceFields(topModuleLocation),
        contentSource: 'elaborated',
        ports: [],
        params: [],
        signals: [explorerSignal('second_state', 'var', 'logic', 1, {
            detail: 'logic second_state',
            location: topModuleLocation,
        })],
    };
    const declarationModuleA = {
        id: 'module:fake:declaration-a',
        name: 'decl_only',
        ...sourceFields({ uri: declarationAUri, range: explorerRange(0, 0, 0, 10) }),
        contentSource: 'declaration',
        isAmbiguous: true,
        ports: [],
        params: [],
        signals: [],
    };
    const declarationModuleB = {
        id: 'module:fake:declaration-b',
        name: 'decl_only',
        ...sourceFields({ uri: declarationBUri, range: explorerRange(0, 0, 0, 10) }),
        contentSource: 'declaration',
        isAmbiguous: true,
        ports: [],
        params: [],
        signals: [],
    };

    const leaf = {
        id: 'instance:fake:top.u_child_small.u_leaf',
        instanceName: 'u_leaf',
        moduleType: 'leaf',
        definitionId: leafModule.id,
        ...sourceFields(leafLocation),
        contentSource: 'elaborated',
        params: [],
        ports: leafModule.ports,
        signals: leafModule.signals,
        generatedScopes: [],
        children: [],
    };
    const childSmall = {
        id: 'instance:fake:top.u_child_small',
        instanceName: 'u_child_small',
        moduleType: 'child',
        definitionId: childModule.id,
        ...sourceFields(childSmallInstanceLocation),
        contentSource: 'elaborated',
        params: [explorerParameter('WIDTH', '8', { location: childWidthLocation })],
        ports: childPorts(8),
        signals: childSignals(8),
        generatedScopes: [],
        children: [leaf],
    };
    const childWide = {
        id: 'instance:fake:top.u_child_wide',
        instanceName: 'u_child_wide',
        moduleType: 'child',
        definitionId: childModule.id,
        ...sourceFields(childWideInstanceLocation),
        contentSource: 'elaborated',
        params: [explorerParameter('WIDTH', '16', { location: childWidthLocation })],
        ports: childPorts(16),
        signals: childSignals(16),
        generatedScopes: [],
        children: [],
    };

    const snapshot = {
        modules: [topModule, childModule, leafModule, secondModule, declarationModuleA, declarationModuleB],
        roots: [
            {
                id: 'instance:fake:top',
                instanceName: 'top',
                moduleType: 'top',
                definitionId: topModule.id,
                ...sourceFields(topModuleLocation),
                contentSource: 'elaborated',
                params: [],
                ports: topModule.ports,
                signals: topModule.signals,
                generatedScopes: [],
                children: [childSmall, childWide],
            },
            {
                id: 'instance:fake:second',
                instanceName: 'second',
                moduleType: 'second',
                definitionId: secondModule.id,
                ...sourceFields(topModuleLocation),
                contentSource: 'elaborated',
                params: [],
                ports: [],
                signals: secondModule.signals,
                generatedScopes: [],
                children: [],
            },
            {
                id: 'instance:fake:decl_only:a',
                instanceName: 'decl_only',
                moduleType: 'decl_only',
                definitionId: declarationModuleA.id,
                ...sourceFields({ uri: declarationAUri, range: explorerRange(0, 0, 0, 10) }),
                contentSource: 'declaration',
                isAmbiguous: true,
                params: [],
                ports: [],
                signals: [],
                generatedScopes: [],
                children: [],
            },
            {
                id: 'instance:fake:decl_only:b',
                instanceName: 'decl_only',
                moduleType: 'decl_only',
                definitionId: declarationModuleB.id,
                ...sourceFields({ uri: declarationBUri, range: explorerRange(0, 0, 0, 10) }),
                contentSource: 'declaration',
                isAmbiguous: true,
                params: [],
                ports: [],
                signals: [],
                generatedScopes: [],
                children: [],
            },
        ],
    };
    recordExplorerSnapshot(snapshot);
    return snapshot;
}

let buffer: Buffer = Buffer.alloc(0);
let lastInitializeParams: unknown = {};

function sendMessage(message: Record<string, unknown>): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n${body}`);
}

function publishDiagnostics(uri: string, diagnostics: readonly RecordValue[]): void {
    sendMessage({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri, diagnostics },
    });
}

function handleMessage(message: IncomingMessage): void {
    if (message.method === 'exit') {
        appendLog('received exit');
        process.exit(0);
    }
    if (message.method === 'initialize') {
        lastInitializeParams = message.params;
        recordInitialize(message.params);
        const mode = currentMode();
        appendLog(`initialize mode=${mode.kind}`);
        if (mode.kind === 'hang') {
            return; // Never answer: exercises client-side startup timeouts.
        }
        sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                capabilities: {
                    textDocumentSync: { openClose: true, change: 1 },
                    hoverProvider: true,
                    definitionProvider: true,
                    referencesProvider: true,
                    documentSymbolProvider: true,
                    workspaceSymbolProvider: true,
                    completionProvider: { triggerCharacters: ['.', ':', '`'] },
                    renameProvider: { prepareProvider: true },
                    semanticTokensProvider: {
                        legend: {
                            tokenTypes: ['keyword', 'class', 'variable'],
                            tokenModifiers: ['declaration', 'definition', 'readonly', 'connectionLabel'],
                        },
                        full: true,
                    },
                },
            },
        });
        sendMessage({
            jsonrpc: '2.0',
            method: MODULE_EXPLORER_CHANGED_NOTIFICATION,
            params: {},
        });
        if (mode.kind === 'crash') {
            // Die shortly after the handshake so the client sees a clean start first.
            setTimeout(() => process.exit(1), 150).unref();
        }
        return;
    }
    if (message.method === 'textDocument/didOpen') {
        const textDocument = asRecord(asRecord(message.params).textDocument);
        const uri = textDocument.uri;
        if (typeof uri === 'string') {
            appendLog(`publishing lint diagnostic uri=${uri}`);
            publishDiagnostics(uri, [{
                range: {
                    start: { line: 4, character: 10 },
                    end: { line: 4, character: 20 },
                },
                severity: 2,
                code: 'unused-signal',
                source: 'llg-lint',
                message: 'signal `unused_sig` is never used',
            }]);
        }
        return;
    }
    if (message.method === 'textDocument/didChange') {
        const uri = asRecord(asRecord(message.params).textDocument).uri;
        if (typeof uri === 'string') {
            appendLog(`clearing diagnostics after change uri=${uri}`);
            publishDiagnostics(uri, []);
        }
        return;
    }
    if (message.method === 'textDocument/hover' && message.id !== undefined && message.id !== null) {
        sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                contents: { kind: 'markdown', value: '**Lapligence fake hover** for `top`' },
                range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
            },
        });
        return;
    }
    if (message.method === 'textDocument/definition' && message.id !== undefined && message.id !== null) {
        sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                uri: workspaceFileUri(lastInitializeParams, 'child.sv'),
                range: { start: { line: 0, character: 7 }, end: { line: 0, character: 12 } },
            },
        });
        return;
    }
    if (message.method === 'textDocument/references' && message.id !== undefined && message.id !== null) {
        sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: [
                {
                    uri: workspaceFileUri(lastInitializeParams, 'top.sv'),
                    range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
                },
                {
                    uri: workspaceFileUri(lastInitializeParams, 'child.sv'),
                    range: { start: { line: 0, character: 7 }, end: { line: 0, character: 12 } },
                },
            ],
        });
        return;
    }
    if (message.method === 'textDocument/documentSymbol' && message.id !== undefined && message.id !== null) {
        sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: [{
                name: 'top',
                detail: 'module',
                kind: 2,
                range: { start: { line: 0, character: 0 }, end: { line: 14, character: 9 } },
                selectionRange: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
                children: [{
                    name: 'unused_sig',
                    detail: 'logic',
                    kind: 13,
                    range: { start: { line: 4, character: 4 }, end: { line: 4, character: 21 } },
                    selectionRange: { start: { line: 4, character: 10 }, end: { line: 4, character: 20 } },
                }],
            }],
        });
        return;
    }
    if (message.method === 'workspace/symbol' && message.id !== undefined && message.id !== null) {
        sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: [{
                name: 'top',
                kind: 2,
                location: {
                    uri: workspaceFileUri(lastInitializeParams, 'top.sv'),
                    range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
                },
            }],
        });
        return;
    }
    if (message.method === 'textDocument/completion' && message.id !== undefined && message.id !== null) {
        sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                isIncomplete: false,
                items: [{
                    label: 'child',
                    kind: 9,
                    detail: 'module child',
                    insertText: 'child',
                }],
            },
        });
        return;
    }
    if (message.method === 'textDocument/semanticTokens/full' && message.id !== undefined && message.id !== null) {
        sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                // `module` => keyword, `top` => class + declaration + definition.
                data: [0, 0, 6, 0, 0, 0, 7, 3, 1, 3],
            },
        });
        return;
    }
    if (message.method === 'textDocument/prepareRename' && message.id !== undefined && message.id !== null) {
        sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
                placeholder: 'top',
            },
        });
        return;
    }
    if (message.method === 'textDocument/rename' && message.id !== undefined && message.id !== null) {
        const newName = asRecord(message.params).newName;
        const topUri = workspaceFileUri(lastInitializeParams, 'top.sv');
        sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                changes: {
                    [topUri]: [{
                        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 10 } },
                        newText: typeof newName === 'string' ? newName : 'renamed_top',
                    }],
                },
            },
        });
        return;
    }
    if (message.method === MODULE_EXPLORER_REQUEST && message.id !== undefined && message.id !== null) {
        appendLog('received module explorer request');
        sendMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: moduleExplorerSnapshot(lastInitializeParams),
        });
        return;
    }
    if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
        appendLog(`received request method=${message.method}`);
        // shutdown and any other request: minimal success reply.
        sendMessage({ jsonrpc: '2.0', id: message.id, result: null });
    }
}

function onData(chunk: Buffer): void {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
        const separator = buffer.indexOf('\r\n\r\n');
        if (separator < 0) {
            break;
        }
        const header = buffer.slice(0, separator).toString('ascii');
        const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
        if (match === null) {
            throw new Error(`malformed headers from client: ${JSON.stringify(header)}`);
        }
        const length = Number.parseInt(match[1], 10);
        const bodyStart = separator + 4;
        if (buffer.length < bodyStart + length) {
            break;
        }
        const body = buffer.slice(bodyStart, bodyStart + length);
        buffer = buffer.slice(bodyStart + length);
        handleMessage(JSON.parse(body.toString('utf8')) as IncomingMessage);
    }
}

appendLaunch();
process.on('uncaughtException', (error: Error) => {
    appendLog(`uncaught exception: ${error.stack ?? error.message}`);
    process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
    appendLog(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
    process.exit(1);
});
process.stdin.on('data', (chunk: Buffer) => onData(chunk));
process.stdin.on('end', () => {
    appendLog('stdin closed');
    process.exit(0);
});
process.stdin.resume();
