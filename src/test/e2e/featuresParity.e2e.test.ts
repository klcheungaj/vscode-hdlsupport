import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
    DDR_CTRL_SV_TEXT,
    TOP_SV_TEXT,
    computeTreeChecksum,
    createRealProjectFixture,
    positionAt,
    type RealProjectFixture,
} from './fixtures/realProject';
import { listTmpLlgShadowDirs } from './fixtures/workspace';
import { LspStdioClient, type IndexedNotification } from './helpers/lspClient';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_BIN = path.join(REPO_ROOT, 'server', 'linux-x64', 'llg_ls');

const READY_TIMEOUT_MS = 150_000;
const DIAGNOSTICS_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 90_000;
const EXIT_TIMEOUT_MS = 10_000;
const READY_MESSAGE_FRAGMENT = 'language server ready';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

// Raw LSP SymbolKind numbers on the wire (vscode numbering is these minus 1):
// llg maps modules→Module(2), ports→Property(7), nets/variables→Variable(13),
// parameters→Constant(14) — see src/commands/ModuleInstantiation.ts.
const LSP_SYMBOL_KIND_MODULE = 2;
const LSP_SYMBOL_KIND_CONSTANT = 14;
const LSP_SYMBOL_KIND_OBJECT = 19;
const PARAMETER_DETAIL_PREFIXES = ['parameter', 'localparam'];

interface RawDocumentSymbol {
    name?: unknown;
    kind?: unknown;
    detail?: unknown;
    children?: unknown;
    location?: unknown;
}

interface ParityProbeResult {
    assertion: string;
    ok: boolean;
    detail: string;
}

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
    console.info(`[skip] featuresParity e2e: staged binary missing or not executable at ${SERVER_BIN}`);
}
const describeIfBinary = binaryAvailable ? describe : describe.skip;

function asRecord(value: unknown): Record<string, unknown> {
    return (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function uriOf(params: unknown): string {
    const uri = asRecord(params).uri;
    return typeof uri === 'string' ? uri : '';
}

function diagnosticsOf(params: unknown): DiagnosticShape[] {
    return asArray(asRecord(params).diagnostics) as DiagnosticShape[];
}

/** Collects Location/LocationLink variants into a list of target URIs. */
function locationUris(result: unknown): string[] {
    const items = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result];
    return items
        .map((item) => asRecord(item))
        .map((item) => (typeof item.uri === 'string' ? item.uri : typeof item.targetUri === 'string' ? item.targetUri : ''))
        .filter((uri) => uri.startsWith('file://'));
}

function completionItems(result: unknown): unknown[] {
    return Array.isArray(result) ? result : asArray(asRecord(result).items);
}

/**
 * Inline replication of the CLIENT-SIDE half of `verilog.instantiateModule`
 * (src/commands/ModuleInstantiation.ts) operating directly on the raw LSP
 * wire response. VS Code shifts kinds by one when converting to
 * vscode.DocumentSymbol (LSP Module=2 → vsc.SymbolKind.Module=1), so the
 * command's `symbol.kind === vsc.SymbolKind.Module` filter is exactly
 * `kind === 2` here. The classifier mirrors classifyModuleChildren(): a child
 * is a parameter when its kind is Constant(14) or its detail starts with
 * parameter/localparam; Object-kind (19) instance children are skipped;
 * everything else becomes a port connection.
 */
function classifyModuleChildrenWire(children: RawDocumentSymbol[]): Array<{ name: string; detail?: string; isParameter: boolean }> {
    const classified: Array<{ name: string; detail?: string; isParameter: boolean }> = [];
    for (const child of children) {
        const name = typeof child.name === 'string' ? child.name : '';
        if (!name || child.kind === LSP_SYMBOL_KIND_OBJECT) {
            continue;
        }
        const detail = typeof child.detail === 'string' ? child.detail : undefined;
        const isParameter =
            child.kind === LSP_SYMBOL_KIND_CONSTANT ||
            PARAMETER_DETAIL_PREFIXES.some((prefix) => detail !== undefined && detail.startsWith(prefix));
        classified.push({ name, detail, isParameter });
    }
    return classified;
}

function findModuleSymbolsWire(symbols: RawDocumentSymbol[]): RawDocumentSymbol[] {
    const modules = symbols.filter((symbol) => symbol.kind === LSP_SYMBOL_KIND_MODULE);
    if (modules.length > 0) {
        return modules;
    }
    // Fallback from findModuleSymbols(): accept any top-level symbol whose
    // children classify into both ports and parameters.
    return symbols.filter((symbol) => {
        const classified = classifyModuleChildrenWire(asArray(symbol.children) as RawDocumentSymbol[]);
        return (
            classified.length > 0 &&
            classified.some((child) => child.isParameter) &&
            classified.some((child) => !child.isParameter)
        );
    });
}

describeIfBinary('llg production-parity features over a real-shaped repo (staged binary)', () => {
    let client!: LspStdioClient;
    let fixture!: RealProjectFixture;
    let initializeResult!: Record<string, unknown>;
    let documentVersion = 1;

    /** Full outcome matrix, printed in afterAll even when individual tests fail. */
    const parityMatrix: ParityProbeResult[] = [];
    const preExistingShadowDirs = new Set<string>();

    /**
     * Runs one [PROD-PARITY] probe, records the outcome for the final matrix
     * report, then rethrows so Vitest marks THIS test red without aborting the
     * remaining probes (full-matrix reporting, no early exit).
     */
    async function parityProbe(assertion: string, probe: () => Promise<string>): Promise<void> {
        try {
            const detail = await probe();
            parityMatrix.push({ assertion, ok: true, detail });
        } catch (error) {
            parityMatrix.push({
                assertion,
                ok: false,
                detail: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    async function documentSymbols(uri: string): Promise<RawDocumentSymbol[]> {
        const result = await client.request<unknown>(
            'textDocument/documentSymbol',
            { textDocument: { uri } },
            REQUEST_TIMEOUT_MS,
        );
        if (result === null || result === undefined) {
            throw new Error('documentSymbol returned null/undefined (expected a symbol array)');
        }
        if (!Array.isArray(result)) {
            throw new Error(`documentSymbol returned ${typeof result} instead of an array`);
        }
        return result as RawDocumentSymbol[];
    }

    function collectDiagnosticPublications(): IndexedNotification[] {
        return client
            .getNotifications()
            .filter((notification) => notification.method === 'textDocument/publishDiagnostics');
    }

    beforeAll(async () => {
        for (const name of listTmpLlgShadowDirs()) {
            preExistingShadowDirs.add(name);
        }
        fixture = createRealProjectFixture();
        // Production parity: the extension launches llg with cwd = workspace
        // folder and LLG_LOG=<hdlsupport.llg.logLevel> (default 'warn').
        client = LspStdioClient.spawn(SERVER_BIN, [], {
            cwd: fixture.projectDir,
            env: { ...process.env, LLG_LOG: 'warn' },
        });

        initializeResult = await client.request<Record<string, unknown>>(
            'initialize',
            {
                processId: process.pid,
                rootUri: null,
                workspaceFolders: [{ uri: fixture.projectUri, name: 'proj' }],
                clientInfo: { name: 'hdlsupport-e2e-prodparity', version: '0.0.1' },
                capabilities: {
                    workspace: {
                        configuration: true,
                        workspaceFolders: true,
                    },
                    textDocument: {
                        publishDiagnostics: { relatedInformation: true },
                        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                        hover: { contentFormat: ['markdown', 'plaintext'] },
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

        // Initial roots finish indexing asynchronously; the ready log message
        // is the same contract the production client relies on.
        await client.waitForNotification(
            'window/logMessage',
            (params) => {
                const message = asRecord(params).message;
                return typeof message === 'string' && message.includes(READY_MESSAGE_FRAGMENT);
            },
            READY_TIMEOUT_MS,
            0,
        );

        // A real user opens ONE file. Everything else stays closed.
        documentVersion += 1;
        client.notify('textDocument/didOpen', {
            textDocument: {
                uri: fixture.topUri,
                languageId: 'systemverilog',
                version: documentVersion,
                text: TOP_SV_TEXT,
            },
        });
        await client.waitForNotification(
            'textDocument/publishDiagnostics',
            (params) => uriOf(params) === fixture.topUri,
            DIAGNOSTICS_TIMEOUT_MS,
        );
    }, 175_000);

    it('[PROD-PARITY][diagnostics] publishes project-wide diagnostics covering >=3 distinct URIs without opening them', async () => {
        // Regression guard for the fixed server behaviour: every compilation
        // unit gets published (open or closed). Startup publications arrived
        // before the single didOpen above.
        const allowedPrefix = `${fixture.projectUri}/`;
        const deadline = Date.now() + DIAGNOSTICS_TIMEOUT_MS;
        const latestPerUri = new Map<string, DiagnosticShape[]>();
        while (Date.now() < deadline) {
            for (const notification of collectDiagnosticPublications()) {
                const uri = uriOf(notification.params);
                if (uri.startsWith(allowedPrefix)) {
                    latestPerUri.set(uri, diagnosticsOf(notification.params));
                }
            }
            if (latestPerUri.size >= 3) {
                break;
            }
            await delayMs(250);
        }

        // Evidence trail: which files were published, with what findings. This
        // doubles as proof that the project really is tainted by exactly one
        // deliberate error (the production premise under test).
        const evidence = [...latestPerUri.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([uri, diagnostics]) => {
                const relative = path.relative(fixture.projectDir, decodeURIComponent(uri.replace(/^file:\/\//, '')));
                const severities = diagnostics.map((diagnostic) => diagnostic.severity ?? 99);
                const worst = severities.length === 0 ? '-' : String(Math.min(...severities));
                const sample = diagnostics[0]?.message?.slice(0, 90) ?? '(clean)';
                return `${relative}: n=${diagnostics.length} worstSeverity=${worst} "${sample}"`;
            });
        console.info(`[PUBLISHED DIAGNOSTICS EVIDENCE]\n${evidence.map((line) => `  ${line}`).join('\n')}`);

        expect(latestPerUri.size).toBeGreaterThanOrEqual(3);
        const covered = [...latestPerUri.keys()]
            .sort()
            .map((uri) => path.relative(fixture.projectDir, decodeURIComponent(uri.replace(/^file:\/\//, ''))));
        expect(covered.join(', ')).toContain('rtl/top.sv');
        // At least one URI the user NEVER opened must be covered.
        expect(covered.some((relative) => relative !== 'rtl/top.sv')).toBe(true);

        // The taint premise: the deliberate missing-include Error in the nested
        // directory is flagged as an Error (severity 1) somewhere project-wide,
        // so whole-project analysis can never come out clean.
        const errorFileUri = fixture.deepModUri;
        const deepModDiagnostics = latestPerUri.get(errorFileUri) ?? [];
        expect(deepModDiagnostics.some((diagnostic) => diagnostic.severity === 1)).toBe(true);
    });

    it('[PROD-PARITY][documentSymbol] opened rtl/top.sv returns >=1 Module symbol', async () => {
        await parityProbe('documentSymbol(top.sv opened) >=1 Module symbol', async () => {
            const symbols = await documentSymbols(fixture.topUri);
            const modules = symbols.filter((symbol) => symbol.kind === LSP_SYMBOL_KIND_MODULE);
            expect(modules.length).toBeGreaterThanOrEqual(1);
            return `symbols=${symbols.length} modules=${modules.length} names=[${modules.map((m) => m.name).join(', ')}]`;
        });
    });

    it('[PROD-PARITY][documentSymbol] never-opened rtl/ddr_ctrl.sv returns >=1 Module symbol', async () => {
        await parityProbe('documentSymbol(ddr_ctrl.sv never opened) >=1 Module symbol', async () => {
            const symbols = await documentSymbols(fixture.ddrCtrlUri);
            const modules = symbols.filter((symbol) => symbol.kind === LSP_SYMBOL_KIND_MODULE);
            expect(modules.length).toBeGreaterThanOrEqual(1);
            return `symbols=${symbols.length} modules=${modules.length}`;
        });
    });

    it('[PROD-PARITY][hover] hovering the ddr_ctrl instantiation in opened top.sv returns non-null', async () => {
        await parityProbe('hover(ddr_ctrl instantiation in top.sv) non-null', async () => {
            const hover = await client.request<unknown>(
                'textDocument/hover',
                {
                    textDocument: { uri: fixture.topUri },
                    position: positionAt(TOP_SV_TEXT, 'ddr_ctrl #(', 4), // dd|r_ctrl
                },
                REQUEST_TIMEOUT_MS,
            );
            expect(hover).not.toBeNull();
            expect(hover).not.toBeUndefined();
            expect(asRecord(hover).contents).toBeDefined();
            return `contents=${JSON.stringify(asRecord(hover).contents).slice(0, 160)}`;
        });
    });

    it('[PROD-PARITY][definition] ddr_ctrl instantiation resolves to rtl/ddr_ctrl.sv', async () => {
        await parityProbe('definition(ddr_ctrl instantiation) -> rtl/ddr_ctrl.sv', async () => {
            const definition = await client.request<unknown>(
                'textDocument/definition',
                {
                    textDocument: { uri: fixture.topUri },
                    position: positionAt(TOP_SV_TEXT, 'ddr_ctrl #(', 2),
                },
                REQUEST_TIMEOUT_MS,
            );
            const uris = locationUris(definition);
            expect(uris.length).toBeGreaterThan(0);
            expect(uris).toContain(fixture.ddrCtrlUri);
            return `targets=${uris.map((uri) => path.relative(fixture.projectDir, decodeURIComponent(uri.replace(/^file:\/\//, '')))).join(', ')}`;
        });
    });

    it('[PROD-PARITY][completion] opened top.sv returns completion items', async () => {
        await parityProbe('completion(top.sv opened) items non-empty', async () => {
            const result = await client.request<unknown>(
                'textDocument/completion',
                {
                    textDocument: { uri: fixture.topUri },
                    position: positionAt(TOP_SV_TEXT, 'u_ddr_ctrl (', 0),
                },
                REQUEST_TIMEOUT_MS,
            );
            const items = completionItems(result);
            expect(items.length).toBeGreaterThan(0);
            return `items=${items.length}`;
        });
    });

    it('[PROD-PARITY][completion] never-opened ddr_ctrl.sv returns completion items', async () => {
        await parityProbe('completion(ddr_ctrl.sv never opened) items non-empty', async () => {
            const result = await client.request<unknown>(
                'textDocument/completion',
                {
                    textDocument: { uri: fixture.ddrCtrlUri },
                    position: positionAt(DDR_CTRL_SV_TEXT, 'assign rdata = wdata;', 16),
                },
                REQUEST_TIMEOUT_MS,
            );
            const items = completionItems(result);
            expect(items.length).toBeGreaterThan(0);
            return `items=${items.length}`;
        });
    });

    it('[PROD-PARITY][semanticTokens] opened include-macro source keeps its tokens', async () => {
        await parityProbe('semanticTokens/full(top.sv opened with include macros) non-empty', async () => {
            const tokens = await client.request<Record<string, unknown>>(
                'textDocument/semanticTokens/full',
                { textDocument: { uri: fixture.topUri } },
                REQUEST_TIMEOUT_MS,
            );
            const data = asArray(tokens.data) as number[];
            // Open buffers are parsed with the committed include context, and
            // a syntax error degrades the stream per token instead of emptying it.
            expect(data.length).toBeGreaterThan(0);
            expect(data.length % 5).toBe(0);
            return `quintets=${data.length / 5}`;
        });
    });

    it('[PROD-PARITY][semanticTokens] never-opened ddr_ctrl.sv returns non-empty token data', async () => {
        await parityProbe('semanticTokens/full(ddr_ctrl.sv never opened) non-empty', async () => {
            const tokens = await client.request<Record<string, unknown>>(
                'textDocument/semanticTokens/full',
                { textDocument: { uri: fixture.ddrCtrlUri } },
                REQUEST_TIMEOUT_MS,
            );
            const data = asArray(tokens.data) as number[];
            expect(data.length).toBeGreaterThan(0);
            return `quintets=${data.length / 5}`;
        });
    });

    it('[INSTANTIATE-MODULE-PRECONDITION] verilog.instantiateModule would find modules in opened top.sv', async () => {
        // Replicates the command precondition: executeDocumentSymbolProvider
        // -> findModuleSymbols(). Empty or Module-less output triggers the
        // user-visible failure "Verilog-HDL/SystemVerilog: No modules found".
        await parityProbe('instantiate precondition (top.sv opened)', async () => {
            const symbols = await documentSymbols(fixture.topUri);
            const modules = findModuleSymbolsWire(symbols);
            expect(modules.length).toBeGreaterThanOrEqual(1);
            const chosen = modules[0];
            const classified = classifyModuleChildrenWire(asArray(chosen.children) as RawDocumentSymbol[]);
            const params = classified.filter((child) => child.isParameter).length;
            const ports = classified.length - params;
            return `command would offer ${modules.length} module(s); '${String(chosen.name)}': ${ports} port(s), ${params} param(s)`;
        });
    });

    it('[INSTANTIATE-MODULE-PRECONDITION] verilog.instantiateModule would find modules in quick-pickable ddr_ctrl.sv', async () => {
        await parityProbe('instantiate precondition (ddr_ctrl.sv via quick pick)', async () => {
            const symbols = await documentSymbols(fixture.ddrCtrlUri);
            const modules = findModuleSymbolsWire(symbols);
            expect(modules.length).toBeGreaterThanOrEqual(1);
            const chosen = modules[0];
            const classified = classifyModuleChildrenWire(asArray(chosen.children) as RawDocumentSymbol[]);
            const params = classified.filter((child) => child.isParameter).length;
            const ports = classified.length - params;
            return `command would offer ${modules.length} module(s); '${String(chosen.name)}': ${ports} port(s), ${params} param(s)`;
        });
    });

    it('keeps the fixture read-only and exits cleanly', async () => {
        const exitInfo = await client.stop(EXIT_TIMEOUT_MS);
        expect(exitInfo.code === 0 || exitInfo.code === null).toBe(true);
        expect(computeTreeChecksum(fixture.projectDir)).toBe(fixture.checksum);
    });
    afterAll(async () => {
        printParityMatrix(parityMatrix);
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

function printParityMatrix(matrix: ParityProbeResult[]): void {
    if (matrix.length === 0) {
        return;
    }
    const lines: string[] = ['', '[PROD-PARITY MATRIX] ------------------------------------------------'];
    for (const row of matrix) {
        lines.push(`${row.ok ? 'PASS' : 'FAIL'}  ${row.assertion}${row.ok ? ` :: ${row.detail}` : ` :: ${row.detail}`}`);
    }
    const failed = matrix.filter((row) => !row.ok);
    if (failed.length === 0) {
        lines.push('VERDICT: all feature probes answered — inconsistent with hypothesis H1.');
    } else if (failed.length === matrix.length) {
        lines.push('VERDICT: EVERY feature probe came back empty while diagnostics still publish — consistent with H1 (features gated behind a last_good snapshot that never materializes on error-containing projects).');
    } else {
        lines.push(`VERDICT: partial feature availability (${matrix.length - failed.length}/${matrix.length} probes answered) — inspect individual rows.`);
    }
    console.info(lines.join('\n'));
}

function delayMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
