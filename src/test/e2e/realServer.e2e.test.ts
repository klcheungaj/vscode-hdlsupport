import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CHILD_SV_TEXT, computeTreeChecksum, createWorkspaceFixture, LLG_TOML_TEXT, listTmpLlgShadowDirs, positionAt, TOP_SV_TEXT, type WorkspaceFixture } from './fixtures/workspace';
import { LspStdioClient, type LspNotification } from './helpers/lspClient';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_BIN = path.join(REPO_ROOT, 'server', 'linux-x64', 'llg_ls');

const READY_TIMEOUT_MS = 90_000;
const DIAGNOSTICS_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 10_000;
const READY_MESSAGE_FRAGMENT = 'language server ready';
const EXPANDED_LINT_RULES = [
    'undriven-signal',
    'incomplete-sensitivity-list',
    'out-of-range-select',
    'xz-logical-equality',
    'duplicate-case-item',
] as const;
const EXPANDED_LINT_TEXT = [
    'module careless_more (',
    '  input  logic       a,',
    '  input  logic       b,',
    '  input  logic [7:0] bus,',
    '  input  logic [1:0] sel,',
    '  output logic       sensitivity_result,',
    '  output logic       case_result,',
    '  output logic       floating_result,',
    '  output logic       range_result,',
    '  output logic       xz_result',
    ');',
    '  logic floating;',
    '  assign floating_result = floating;',
    '  always @(a)',
    '    sensitivity_result = a & b;',
    '  assign range_result = bus[8];',
    "  assign xz_result = (a == 1'bx);",
    '  always_comb begin',
    '    case (sel)',
    "      2'd0: case_result = 1'b0;",
    "      2'd1: case_result = 1'b1;",
    "      2'd1: case_result = a;",
    '      default: case_result = b;',
    '    endcase',
    '  end',
    'endmodule',
    '',
].join('\n');

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

interface DiagnosticShape {
    severity?: number;
    code?: string | number;
    source?: string;
    message?: string;
    range?: { start?: { line?: number; character?: number } };
}

function serverBinaryAvailable(): boolean {
    try {
        fs.accessSync(SERVER_BIN, fs.constants.X_OK);
        return fs.statSync(SERVER_BIN).isFile();
    } catch {
        return false;
    }
}

const binaryAvailable = serverBinaryAvailable();
if (!binaryAvailable) {
    console.info(`[skip] realServer e2e: staged binary missing or not executable at ${SERVER_BIN}`);
}
const describeIfBinary = binaryAvailable ? describe : describe.skip;

function asRecord(value: unknown): Record<string, unknown> {
    return (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function diagnosticsOf(params: unknown): DiagnosticShape[] {
    return asArray(asRecord(params).diagnostics) as DiagnosticShape[];
}

function uriOf(params: unknown): string {
    const uri = asRecord(params).uri;
    return typeof uri === 'string' ? uri : '';
}

function hasSeverity(params: unknown, severity: number): boolean {
    return diagnosticsOf(params).some((diagnostic) => diagnostic.severity === severity);
}

/** True when every diagnostic in the publication is free of `severity`. */
function freeOfSeverity(params: unknown, severity: number): boolean {
    return !hasSeverity(params, severity);
}

/** Normalized [severity, source/code, message, startLine] tuples for stable comparisons. */
function diagnosticFingerprint(params: unknown): string[] {
    return diagnosticsOf(params)
        .map((diagnostic) => JSON.stringify([
            diagnostic.severity ?? null,
            diagnostic.source ?? (typeof diagnostic.code !== 'undefined' ? String(diagnostic.code) : null),
            diagnostic.message ?? '',
            diagnostic.range?.start?.line ?? null,
        ]))
        .sort();
}

function isUnusedSignalDiagnostic(diagnostic: DiagnosticShape): boolean {
    if (typeof diagnostic.message === 'string' && /unused[-_ ]?signal/i.test(diagnostic.message)) {
        return true;
    }
    return diagnostic.source === 'llg-lint'
        && (String(diagnostic.code ?? '') === 'unused-signal'
            || /unused[-_ ]?signal/i.test(String(diagnostic.message ?? '')));
}

function lintRuleCodes(params: unknown): Set<string> {
    return new Set(diagnosticsOf(params)
        .filter((diagnostic) => diagnostic.source === 'llg-lint')
        .map((diagnostic) => String(diagnostic.code ?? '')));
}

function workspaceEdits(result: unknown, uri: string): Record<string, unknown>[] {
    const changes = asRecord(asRecord(result).changes);
    return asArray(changes[uri]).map(asRecord);
}

/** Collects Location/LocationLink variants into a list of target URIs. */
function locationUris(result: unknown): string[] {
    const items = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result];
    return items
        .map((item) => asRecord(item))
        .map((item) => (typeof item.uri === 'string' ? item.uri : typeof item.targetUri === 'string' ? item.targetUri : ''))
        .filter((uri) => uri.startsWith('file://'));
}

function scalarLocationUri(result: unknown, what: string): string {
    expect(Array.isArray(result)).toBe(false);
    const location = asRecord(result);
    const uri = typeof location.uri === 'string'
        ? location.uri
        : typeof location.targetUri === 'string'
            ? location.targetUri
            : '';
    expect(uri, `${what} did not return a scalar Location/LocationLink`).toMatch(/^file:\/\//);
    return uri;
}

describeIfBinary('llg language server end-to-end (staged binary)', () => {
    let client!: LspStdioClient;
    let fixture!: WorkspaceFixture;
    let initializeResult!: Record<string, unknown>;
    let baselineDiagnostics: DiagnosticShape[] = [];
    /** publishDiagnostics that arrived during startup, before any didOpen. */
    let startupDiagnostics: LspNotification[] = [];
    const preExistingShadowDirs = new Set<string>();
    let documentVersion = 1;

    beforeAll(async () => {
        for (const name of listTmpLlgShadowDirs()) {
            preExistingShadowDirs.add(name);
        }
        fixture = createWorkspaceFixture();
        client = LspStdioClient.spawn(SERVER_BIN, [], { cwd: fixture.projectDir });

        initializeResult = await client.request<Record<string, unknown>>(
            'initialize',
            {
                processId: process.pid,
                rootUri: null,
                workspaceFolders: [{ uri: fixture.projectUri, name: 'proj' }],
                clientInfo: { name: 'hdlsupport-e2e-tests', version: '0.0.1' },
                capabilities: {
                    workspace: {
                        configuration: true,
                        workspaceFolders: true,
                    },
                    textDocument: {
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
                        configFiles: [
                            { workspaceUri: fixture.projectUri, path: fixture.configPath },
                        ],
                    },
                },
            },
            REQUEST_TIMEOUT_MS,
        );
        client.notify('initialized', {});

        // Initial roots finish indexing asynchronously; the ready log message is the contract.
        await client.waitForNotification(
            'window/logMessage',
            (params) => {
                const message = asRecord(params).message;
                return typeof message === 'string' && message.includes(READY_MESSAGE_FRAGMENT);
            },
            READY_TIMEOUT_MS,
            0,
        );

        startupDiagnostics = client
            .getNotifications()
            .filter((notification) => notification.method === 'textDocument/publishDiagnostics');
    }, 180_000);

    it('advertises the expected language features and full text sync', () => {
        expect(initializeResult).toBeDefined();
        const capabilities = asRecord(initializeResult.capabilities);
        for (const flag of [
            'hoverProvider',
            'definitionProvider',
            'referencesProvider',
            'documentSymbolProvider',
            'workspaceSymbolProvider',
            'renameProvider',
            'completionProvider',
            'semanticTokensProvider',
        ]) {
            expect(capabilities[flag]).toBeTruthy();
        }
        const completion = asRecord(capabilities.completionProvider);
        const triggers = asArray(completion.triggerCharacters).map(String);
        expect(triggers).toEqual(expect.arrayContaining(['.', ':', '`']));
        expect(asRecord(capabilities.renameProvider).prepareProvider).toBe(true);

        const sync: unknown = capabilities.textDocumentSync;
        const isFull = sync === 1
            || (typeof sync === 'object' && sync !== null && asRecord(sync).change === 1);
        expect(isFull).toBe(true);
    });

    it('publishes diagnostics after didOpen even when the list is empty', async () => {
        // Startup sanity: nothing referenced files outside the fixture tree.
        // URIs are file:// URLs; compare them against the project URI prefix.
        const allowedPrefix = `${fixture.projectUri}/`;
        for (const notification of startupDiagnostics) {
            expect(uriOf(notification.params).startsWith(allowedPrefix)).toBe(true);
        }

        const cursor = client.notificationCount;
        documentVersion += 1;
        client.notify('textDocument/didOpen', {
            textDocument: {
                uri: fixture.topUri,
                languageId: 'systemverilog',
                version: documentVersion,
                text: TOP_SV_TEXT,
            },
        });
        const publication = await client.waitForNotification(
            'textDocument/publishDiagnostics',
            (params) => uriOf(params) === fixture.topUri,
            DIAGNOSTICS_TIMEOUT_MS,
            cursor,
        );
        baselineDiagnostics = diagnosticsOf(publication.params);
        expect(Array.isArray(baselineDiagnostics)).toBe(true);
    });

    it('answers documentSymbol, hover, definition, completion and semanticTokens requests', async () => {
        const symbols = await client.request(
            'textDocument/documentSymbol',
            { textDocument: { uri: fixture.topUri } },
            REQUEST_TIMEOUT_MS,
        );
        const topLevel = asArray(symbols).map(asRecord);
        const topModule = topLevel.find((symbol) => symbol.name === 'top');
        expect(topModule).toBeDefined();
        expect(topModule?.kind).toBe(2); // SymbolKind.Module
        expect(asArray(topModule?.children).length).toBeGreaterThan(0);
        const childNames = asArray(topModule?.children)
            .map(asRecord)
            .map((child) => child.name);
        expect(childNames).toContain('unused_sig');

        const hover = await client.request(
            'textDocument/hover',
            {
                textDocument: { uri: fixture.topUri },
                position: positionAt(TOP_SV_TEXT, 'module top', 8), // module t|op
            },
            REQUEST_TIMEOUT_MS,
        );
        expect(hover).not.toBeNull();
        expect(asRecord(hover).contents).toBeDefined();

        const definition = await client.request(
            'textDocument/definition',
            {
                textDocument: { uri: fixture.topUri },
                position: positionAt(TOP_SV_TEXT, 'u_child', 2),
            },
            REQUEST_TIMEOUT_MS,
        );
        const uris = locationUris(definition);
        expect(uris.length).toBeGreaterThan(0);
        expect(uris.some((uri) => uri === fixture.childUri)).toBe(true);

        const completion = await client.request(
            'textDocument/completion',
            {
                textDocument: { uri: fixture.topUri },
                position: positionAt(TOP_SV_TEXT, 'child u_child', 'child '.length),
            },
            REQUEST_TIMEOUT_MS,
        );
        const items = Array.isArray(completion)
            ? completion
            : asArray(asRecord(completion).items);
        expect(Array.isArray(items)).toBe(true);

        const tokens = await client.request<Record<string, unknown>>(
            'textDocument/semanticTokens/full',
            { textDocument: { uri: fixture.topUri } },
            REQUEST_TIMEOUT_MS,
        );
        const data = asArray(tokens.data);
        expect(data.length).toBeGreaterThan(0);
        expect(data.length % 5).toBe(0);
    });

    it('returns one scalar definition for every cursor inside a module identifier, including its declaration', async () => {
        // Arrange
        const typeNeedle = 'child u_child_small';
        const moduleName = 'module child';

        // Act / Assert
        for (let offset = 0; offset < 'child'.length; offset += 1) {
            const result = await client.request<unknown>(
                'textDocument/definition',
                {
                    textDocument: { uri: fixture.topUri },
                    position: positionAt(TOP_SV_TEXT, typeNeedle, offset),
                },
                REQUEST_TIMEOUT_MS,
            );
            expect(scalarLocationUri(result, `module type cursor ${offset}`)).toBe(fixture.childUri);
        }

        const declarationResult = await client.request<unknown>(
            'textDocument/definition',
            {
                textDocument: { uri: fixture.childUri },
                position: positionAt(CHILD_SV_TEXT, moduleName, 'module '.length),
            },
            REQUEST_TIMEOUT_MS,
        );
        expect(scalarLocationUri(declarationResult, 'module declaration cursor')).toBe(fixture.childUri);
    });

    it('prepares and returns cross-file edits for a port rename without writing files', async () => {
        const childClock = positionAt(CHILD_SV_TEXT, 'clk,');
        const prepared = asRecord(await client.request(
            'textDocument/prepareRename',
            {
                textDocument: { uri: fixture.childUri },
                position: childClock,
            },
            REQUEST_TIMEOUT_MS,
        ));
        expect(prepared.placeholder).toBe('clk');
        expect(asRecord(prepared.range).start).toEqual(childClock);

        const rename = await client.request(
            'textDocument/rename',
            {
                textDocument: { uri: fixture.childUri },
                position: childClock,
                newName: 'clock_i',
            },
            REQUEST_TIMEOUT_MS,
        );
        const childEdits = workspaceEdits(rename, fixture.childUri);
        const topEdits = workspaceEdits(rename, fixture.topUri);
        expect(childEdits).toHaveLength(1);
        expect(topEdits).toHaveLength(2);
        for (const edit of [...childEdits, ...topEdits]) {
            expect(edit.newText).toBe('clock_i');
            const range = asRecord(edit.range);
            const start = asRecord(range.start);
            const end = asRecord(range.end);
            expect(end.line).toBe(start.line);
            expect(Number(end.character) - Number(start.character)).toBe(3);
        }
    });

    it('flags syntax errors in unsaved buffers and recovers back to baseline', async () => {
        const brokenText = 'modul broken;\nendmodule\n';

        const cursor = client.notificationCount;
        documentVersion += 1;
        client.notify('textDocument/didChange', {
            textDocument: { uri: fixture.topUri, version: documentVersion },
            contentChanges: [{ text: brokenText }],
        });
        const errorPublication = await client.waitForNotification(
            'textDocument/publishDiagnostics',
            (params) => uriOf(params) === fixture.topUri && hasSeverity(params, 1),
            DIAGNOSTICS_TIMEOUT_MS,
            cursor,
        );
        expect(diagnosticsOf(errorPublication.params).some((d) => d.severity === 1)).toBe(true);

        // Only consider publications arriving after the error one.
        const afterError = errorPublication.index + 1;
        documentVersion += 1;
        client.notify('textDocument/didChange', {
            textDocument: { uri: fixture.topUri, version: documentVersion },
            contentChanges: [{ text: TOP_SV_TEXT }],
        });
        const recovered = await client.waitForNotification(
            'textDocument/publishDiagnostics',
            (params) => uriOf(params) === fixture.topUri && freeOfSeverity(params, 1),
            DIAGNOSTICS_TIMEOUT_MS,
            afterError,
        );
        expect(freeOfSeverity(recovered.params, 1)).toBe(true);
        expect(diagnosticFingerprint(recovered.params)).toEqual(diagnosticFingerprint({ diagnostics: baselineDiagnostics }));
    });

    it('publishes all five expanded careless-mistake lint rules and clears them after recovery', async () => {
        const cursor = client.notificationCount;
        documentVersion += 1;
        client.notify('textDocument/didChange', {
            textDocument: { uri: fixture.topUri, version: documentVersion },
            contentChanges: [{ text: EXPANDED_LINT_TEXT }],
        });
        const publication = await client.waitForNotification(
            'textDocument/publishDiagnostics',
            (params) => {
                const codes = lintRuleCodes(params);
                return uriOf(params) === fixture.topUri
                    && EXPANDED_LINT_RULES.every((rule) => codes.has(rule));
            },
            DIAGNOSTICS_TIMEOUT_MS,
            cursor,
        );
        const codes = lintRuleCodes(publication.params);
        for (const rule of EXPANDED_LINT_RULES) {
            const diagnostic = diagnosticsOf(publication.params).find((candidate) => candidate.code === rule);
            expect(codes.has(rule), `missing ${rule}`).toBe(true);
            expect(diagnostic?.source).toBe('llg-lint');
            expect(diagnostic?.severity).toBe(2);
        }

        documentVersion += 1;
        client.notify('textDocument/didChange', {
            textDocument: { uri: fixture.topUri, version: documentVersion },
            contentChanges: [{ text: TOP_SV_TEXT }],
        });
        const recovered = await client.waitForNotification(
            'textDocument/publishDiagnostics',
            (params) => uriOf(params) === fixture.topUri
                && EXPANDED_LINT_RULES.every((rule) => !lintRuleCodes(params).has(rule)),
            DIAGNOSTICS_TIMEOUT_MS,
            publication.index + 1,
        );
        expect(diagnosticFingerprint(recovered.params)).toEqual(diagnosticFingerprint({ diagnostics: baselineDiagnostics }));
    });

    it('honors the disabled unused-signal lint rule from llg.toml end-to-end', () => {
        const publications = client
            .getNotifications()
            .filter((notification) => notification.method === 'textDocument/publishDiagnostics');
        // The open/change cycle must have produced diagnostics traffic to validate against.
        expect(publications.some((notification) => uriOf(notification.params) === fixture.topUri)).toBe(true);

        const offenders: DiagnosticShape[] = [];
        for (const notification of publications) {
            for (const diagnostic of diagnosticsOf(notification.params)) {
                if (isUnusedSignalDiagnostic(diagnostic)) {
                    offenders.push(diagnostic);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('publishes an enabled built-in lint finding with source and rule code', async () => {
        const enabledConfig = LLG_TOML_TEXT.replace('enabled = false', 'enabled = true');
        let restored = false;
        try {
            const cursor = client.notificationCount;
            fs.writeFileSync(fixture.configPath, enabledConfig);
            client.notify('workspace/didChangeWatchedFiles', {
                changes: [{ uri: pathToFileURL(fixture.configPath).href, type: 2 }],
            });
            const publication = await client.waitForNotification(
                'textDocument/publishDiagnostics',
                (params) => uriOf(params) === fixture.topUri
                    && diagnosticsOf(params).some(isUnusedSignalDiagnostic),
                DIAGNOSTICS_TIMEOUT_MS,
                cursor,
            );
            const diagnostic = diagnosticsOf(publication.params).find(isUnusedSignalDiagnostic);
            expect(diagnostic?.source).toBe('llg-lint');
            expect(diagnostic?.code).toBe('unused-signal');
            expect(diagnostic?.severity).toBe(2);
        } finally {
            const cursor = client.notificationCount;
            fs.writeFileSync(fixture.configPath, LLG_TOML_TEXT);
            client.notify('workspace/didChangeWatchedFiles', {
                changes: [{ uri: pathToFileURL(fixture.configPath).href, type: 2 }],
            });
            await client.waitForNotification(
                'textDocument/publishDiagnostics',
                (params) => uriOf(params) === fixture.topUri
                    && !diagnosticsOf(params).some(isUnusedSignalDiagnostic),
                DIAGNOSTICS_TIMEOUT_MS,
                cursor,
            );
            restored = true;
        }
        expect(restored).toBe(true);
    });

    it('keeps the fixture read-only, exits cleanly and removes its temp shadow tree', async () => {
        const exitInfo = await client.stop(EXIT_TIMEOUT_MS);
        expect(exitInfo.code === 0 || exitInfo.code === null).toBe(true);

        // The project tree must be byte-identical after the whole session.
        expect(computeTreeChecksum(fixture.projectDir)).toBe(fixture.checksum);

        // Dirs from other concurrent llg processes are never attributed to us.
        const leakedByServer = [...listTmpLlgShadowDirs()]
            .filter((name) => !preExistingShadowDirs.has(name))
            .filter((name) => client.pid !== undefined && name.startsWith(`llg-${client.pid}-`));
        expect(leakedByServer).toEqual([]);
    });

    afterAll(async () => {
        // Safety net when an earlier test failed before the shutdown test ran.
        if (binaryAvailable && typeof client !== 'undefined' && client !== undefined) {
            try {
                if (!client.exited) {
                    await client.kill();
                }
            } catch {
                // Best effort.
            }
        }
        if (binaryAvailable && typeof fixture !== 'undefined' && fixture !== undefined) {
            fixture.dispose();
        }
    }, 30_000);
});
