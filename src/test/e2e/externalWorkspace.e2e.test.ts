import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { computeTreeChecksum, positionAt } from './fixtures/workspace';
import { LspStdioClient } from './helpers/lspClient';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_BIN = path.join(REPO_ROOT, 'server', 'linux-x64', 'llg_ls');
const EXTERNAL_WORKSPACE_ENV = 'HDLSUPPORT_E2E_EXTERNAL_WORKSPACE';
const configuredWorkspace = process.env[EXTERNAL_WORKSPACE_ENV]?.trim();
const READY_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 90_000;

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

function serverBinaryAvailable(): boolean {
    try {
        fs.accessSync(SERVER_BIN, fs.constants.X_OK);
        return fs.statSync(SERVER_BIN).isFile();
    } catch {
        return false;
    }
}

const binaryAvailable = serverBinaryAvailable();
const externalWorkspaceEnabled = configuredWorkspace !== undefined && configuredWorkspace !== '';
if (!externalWorkspaceEnabled) {
    console.info(`[skip] external-workspace e2e: set ${EXTERNAL_WORKSPACE_ENV} to an HDL project checkout`);
} else if (!binaryAvailable) {
    console.info(`[skip] external-workspace e2e: staged binary missing or not executable at ${SERVER_BIN}`);
}
const describeIfEnabled = binaryAvailable && externalWorkspaceEnabled ? describe : describe.skip;

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function uriOf(value: unknown): string {
    const uri = asRecord(value).uri;
    return typeof uri === 'string' ? uri : '';
}

function locationUris(value: unknown): string[] {
    const locations = Array.isArray(value) ? value : value === null ? [] : [value];
    return locations.map(asRecord).map((location) => {
        if (typeof location.uri === 'string') {
            return location.uri;
        }
        return typeof location.targetUri === 'string' ? location.targetUri : '';
    }).filter((uri) => uri !== '');
}

function completionItems(value: unknown): Record<string, unknown>[] {
    const raw = Array.isArray(value) ? value : asArray(asRecord(value).items);
    return raw.map(asRecord);
}

function createExternalConfig(configPath: string, rtlDir: string): void {
    const includeDirs = [rtlDir, path.join(rtlDir, 'res_sweep')];
    fs.writeFileSync(configPath, [
        'schema_version = 1',
        '',
        '[sources]',
        `directories = [${JSON.stringify(rtlDir)}]`,
        'include = ["**/*.v", "**/*.sv"]',
        'exclude = []',
        '',
        '[compile]',
        `include_dirs = [${includeDirs.map((dir) => JSON.stringify(dir)).join(', ')}]`,
        '',
    ].join('\n'));
}

describeIfEnabled.each(['rtl-config', 'default-discovery'])(
    'llg opt-in external-workspace smoke contract (%s)', (mode) => {
    let client!: LspStdioClient;
    let workspaceRoot!: string;
    let workspaceUri!: string;
    let rtlDir!: string;
    let configRoot!: string;
    let configPath!: string;
    let cfgPath!: string;
    let cfgUri!: string;
    let cfgText!: string;
    let rtlChecksum: string | undefined;
    let initializeResult!: Record<string, unknown>;

    beforeAll(async () => {
        workspaceRoot = path.resolve(configuredWorkspace as string);
        rtlDir = path.join(workspaceRoot, 'rtl');
        cfgPath = path.join(rtlDir, 'cfg_fsm.sv');
        if (!fs.statSync(workspaceRoot, { throwIfNoEntry: false })?.isDirectory()) {
            throw new Error(`${EXTERNAL_WORKSPACE_ENV} is not a directory: ${workspaceRoot}`);
        }
        if (!fs.statSync(rtlDir, { throwIfNoEntry: false })?.isDirectory() || !fs.existsSync(cfgPath)) {
            throw new Error(`external workspace must contain rtl/cfg_fsm.sv: ${workspaceRoot}`);
        }

        workspaceUri = pathToFileURL(workspaceRoot).href;
        cfgUri = pathToFileURL(cfgPath).href;
        cfgText = fs.readFileSync(cfgPath, 'utf8');
        rtlChecksum = computeTreeChecksum(rtlDir);
        configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hdlsupport-external-config-'));
        configPath = path.join(configRoot, 'llg.toml');
        createExternalConfig(configPath, rtlDir);

        client = LspStdioClient.spawn(SERVER_BIN, [], {
            cwd: workspaceRoot,
            requestTimeoutMs: REQUEST_TIMEOUT_MS,
        });
        initializeResult = await client.request<Record<string, unknown>>('initialize', {
            processId: process.pid,
            rootUri: null,
            workspaceFolders: [{ uri: workspaceUri, name: path.basename(workspaceRoot) }],
            clientInfo: { name: 'hdlsupport-external-workspace-e2e', version: '0.0.1' },
            capabilities: {
                workspace: { configuration: true, workspaceFolders: true },
                textDocument: {
                    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                    publishDiagnostics: { relatedInformation: true },
                    semanticTokens: {
                        dynamicRegistration: false,
                        requests: { range: true, full: true },
                        tokenTypes: [],
                        tokenModifiers: [],
                        formats: ['relative'],
                    },
                },
            },
            initializationOptions: {
                llg: {
                    protocolVersion: 1,
                    configFiles: mode === 'rtl-config' ? [{ workspaceUri, path: configPath }] : [],
                },
            },
        });
        client.notify('initialized', {});
        await client.waitForNotification(
            'window/logMessage',
            (params) => String(asRecord(params).message ?? '').includes('language server ready'),
            READY_TIMEOUT_MS,
            0,
        );
    });

    it('indexes a realistic mixed Verilog/SystemVerilog tree', async () => {
        const capabilities = asRecord(initializeResult.capabilities);
        for (const capability of [
            'hoverProvider',
            'definitionProvider',
            'referencesProvider',
            'documentSymbolProvider',
            'workspaceSymbolProvider',
            'renameProvider',
            'completionProvider',
            'semanticTokensProvider',
        ]) {
            expect(capabilities[capability], `missing ${capability}`).toBeTruthy();
        }

        const workspaceSymbols = asArray(await client.request(
            'workspace/symbol',
            { query: 'cfg_fsm' },
            REQUEST_TIMEOUT_MS,
        )).map(asRecord);
        expect(workspaceSymbols.some((symbol) => symbol.name === 'cfg_fsm')).toBe(true);

        const snapshot = asRecord(await client.request('llg/moduleExplorer', {}, REQUEST_TIMEOUT_MS));
        const modules = asArray(snapshot.modules).map(asRecord);
        expect(modules.some((module) => module.name === 'cfg_fsm')).toBe(true);
        expect(modules.length).toBeGreaterThan(5);
    });

    it('serves providers and diagnostics for an opened real source buffer', async () => {
        const publicationCursor = client.notificationCount;
        client.notify('textDocument/didOpen', {
            textDocument: {
                uri: cfgUri,
                languageId: 'systemverilog',
                version: 1,
                text: cfgText,
            },
        });
        const publication = await client.waitForNotification(
            'textDocument/publishDiagnostics',
            (params) => uriOf(params) === cfgUri,
            READY_TIMEOUT_MS,
            publicationCursor,
        );
        expect(Array.isArray(asRecord(publication.params).diagnostics)).toBe(true);

        const symbols = asArray(await client.request(
            'textDocument/documentSymbol',
            { textDocument: { uri: cfgUri } },
            REQUEST_TIMEOUT_MS,
        )).map(asRecord);
        expect(symbols.some((symbol) => symbol.name === 'cfg_fsm')).toBe(true);

        const modulePosition = positionAt(cfgText, 'module cfg_fsm', 'module '.length + 1);
        const hover = await client.request(
            'textDocument/hover',
            { textDocument: { uri: cfgUri }, position: modulePosition },
            REQUEST_TIMEOUT_MS,
        );
        expect(hover).not.toBeNull();

        const definition = await client.request(
            'textDocument/definition',
            { textDocument: { uri: cfgUri }, position: modulePosition },
            REQUEST_TIMEOUT_MS,
        );
        expect(locationUris(definition)).toContain(cfgUri);

        const references = await client.request(
            'textDocument/references',
            {
                textDocument: { uri: cfgUri },
                position: positionAt(cfgText, 'cfg_start,', 1),
                context: { includeDeclaration: true },
            },
            REQUEST_TIMEOUT_MS,
        );
        expect(locationUris(references).filter((uri) => uri === cfgUri).length).toBeGreaterThan(1);

        const completions = completionItems(await client.request(
            'textDocument/completion',
            { textDocument: { uri: cfgUri }, position: positionAt(cfgText, 'assign cfg_start', 'assign '.length) },
            REQUEST_TIMEOUT_MS,
        ));
        expect(completions.length).toBeGreaterThan(0);
        expect(completions.some((item) => item.label === 'cfg_start')).toBe(true);

        const tokens = asRecord(await client.request(
            'textDocument/semanticTokens/full',
            { textDocument: { uri: cfgUri } },
            REQUEST_TIMEOUT_MS,
        ));
        const tokenData = asArray(tokens.data);
        expect(tokenData.length).toBeGreaterThan(0);
        expect(tokenData.length % 5).toBe(0);

        const dump = asRecord(await client.request(
            'llg/dumpTokens',
            { uri: cfgUri },
            REQUEST_TIMEOUT_MS,
        ));
        const dumpLines = asArray(dump.lines);
        expect(dumpLines.length).toBeGreaterThan(1);
        expect(dumpLines.some((line) => String(line).includes('cfg_fsm'))).toBe(true);
        expect(String(dumpLines.at(-1))).toContain('# analysis:');
    });

    it('serves navigation and token dumps in top.sv with the full workspace present', async () => {
        const topPath = path.join(rtlDir, 'top.sv');
        const topUri = pathToFileURL(topPath).href;
        const topText = fs.readFileSync(topPath, 'utf8');
        client.notify('textDocument/didOpen', {
            textDocument: { uri: topUri, languageId: 'systemverilog', version: 1, text: topText },
        });
        const position = positionAt(topText, 'reset_ctrl #(', 1);
        const definition = await client.request('textDocument/definition', {
            textDocument: { uri: topUri }, position,
        }, REQUEST_TIMEOUT_MS);
        expect(locationUris(definition)).toContain(pathToFileURL(path.join(rtlDir, 'library', 'reset_ctrl.v')).href);
        expect(await client.request('textDocument/hover', {
            textDocument: { uri: topUri }, position,
        }, REQUEST_TIMEOUT_MS)).not.toBeNull();
        const dump = asRecord(await client.request('llg/dumpTokens', { uri: topUri }, REQUEST_TIMEOUT_MS));
        expect(asArray(dump.lines).some((line) => String(line).includes('reset_ctrl'))).toBe(true);
        const tokens = asRecord(await client.request('textDocument/semanticTokens/full', {
            textDocument: { uri: topUri },
        }, REQUEST_TIMEOUT_MS));
        expect(asArray(tokens.data).length).toBeGreaterThan(0);
    });

    it('leaves the external project byte-for-byte unchanged', async () => {
        const exit = await client.stop(15_000);
        expect(exit.code === 0 || exit.code === null).toBe(true);
        expect(computeTreeChecksum(rtlDir)).toBe(rtlChecksum);
    });

    afterAll(async () => {
        if (typeof client !== 'undefined' && !client.exited) {
            await client.kill();
        }
        if (rtlChecksum !== undefined && typeof rtlDir !== 'undefined' && fs.existsSync(rtlDir)) {
            expect(computeTreeChecksum(rtlDir)).toBe(rtlChecksum);
        }
        if (typeof configRoot !== 'undefined') {
            fs.rmSync(configRoot, { recursive: true, force: true });
        }
    });
});
