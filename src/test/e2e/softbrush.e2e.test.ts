// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { tokenize } from '../syntaxes/grammarHarness';
import { TCL_HIGHLIGHT_SOURCES } from './fixtures/tclHighlighting';
import { LspStdioClient } from './helpers/lspClient';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_BIN = path.join(REPO_ROOT, 'server', 'linux-x64', 'softbrush_ls');
const REQUEST_TIMEOUT_MS = 30_000;
const DIAGNOSTICS_TIMEOUT_MS = 30_000;

const TCL_URI = 'file:///tmp/hdlsupport-softbrush-contract.tcl';
const SDC_URI = 'file:///tmp/hdlsupport-softbrush-contract.sdc';
const XDC_URI = 'file:///tmp/hdlsupport-softbrush-contract.xdc';

const TCL_SOURCE = [
    '# Softbrush contract',
    'proc scale {value} { return $value }',
    'set count 42',
    '',
].join('\n');
const SDC_VENDOR_SOURCE = 'acme_set_clock_latency -corner fast [get_clocks sys_clk]\n';
const XDC_VENDOR_SOURCE = [
    'acme_route_clock -region north [get_nets sys_clk]',
    'create_clock -name sys_clk -period 10 [get_ports clk]',
    '',
].join('\n');
const INVALID_SOURCE = 'puts "unterminated';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

interface DiagnosticShape {
    severity?: number;
    code?: string | number;
    source?: string;
    message?: string;
}

function isEnabled(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function serverBinaryAvailable(): boolean {
    try {
        fs.accessSync(SERVER_BIN, fs.constants.X_OK);
        return fs.statSync(SERVER_BIN).isFile();
    } catch {
        return false;
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function diagnosticsOf(params: unknown): DiagnosticShape[] {
    return asArray(asRecord(params).diagnostics) as DiagnosticShape[];
}

/** The TextMate scope VS Code falls back to for each Softbrush semantic token type. */
const SEMANTIC_FALLBACK_SCOPES: Record<string, string> = {
    comment: 'comment',
    string: 'string',
    number: 'constant.numeric',
    keyword: 'keyword.control',
    operator: 'keyword.operator',
    variable: 'variable.other.readwrite',
    function: 'entity.name.function',
    parameter: 'variable.parameter',
    namespace: 'entity.name.namespace',
};

interface CharacterClass {
    type: string;
    declaration: boolean;
    text: string;
}

/** Decodes relative semantic tokens into a per-character classification. */
function semanticClasses(data: number[], legend: Record<string, unknown>, lines: string[]): Map<string, CharacterClass> {
    const tokenTypes = asArray(legend.tokenTypes) as string[];
    const declarationBit = 1 << (asArray(legend.tokenModifiers) as string[]).indexOf('declaration');
    const classes = new Map<string, CharacterClass>();
    let line = 0;
    let start = 0;
    for (let index = 0; index < data.length; index += 5) {
        const [deltaLine, deltaStart, length, type, modifiers] = data.slice(index, index + 5);
        line += deltaLine;
        start = deltaLine === 0 ? start + deltaStart : deltaStart;
        const text = lines[line].slice(start, start + length);
        for (let column = start; column < start + length; column += 1) {
            classes.set(`${line}:${column}`, {
                type: tokenTypes[type],
                declaration: (modifiers & declarationBit) !== 0,
                text,
            });
        }
    }
    return classes;
}

/** The semantic type a theme would color a TextMate token as, from its innermost matching scope. */
function textMateType(scopes: string[]): string | undefined {
    return [...scopes].reverse().flatMap((scope) => Object.entries(SEMANTIC_FALLBACK_SCOPES)
        .filter(([, fallback]) => scope === fallback || scope.startsWith(`${fallback}.`))
        .map(([type]) => type))[0];
}

const binaryAvailable = serverBinaryAvailable();
const requireSoftbrush = isEnabled(process.env.REQUIRE_SOFTBRUSH);
if (requireSoftbrush && !binaryAvailable) {
    throw new Error(
        `REQUIRE_SOFTBRUSH is enabled, but no executable staged language server was found at ${SERVER_BIN}. `
        + 'Run npm run stage:softbrush first.',
    );
}
if (!binaryAvailable) {
    console.info(`[skip] softbrush e2e: staged binary missing or not executable at ${SERVER_BIN}`);
}
const describeIfBinary = binaryAvailable ? describe : describe.skip;

describeIfBinary('Softbrush language server end-to-end (staged binary)', () => {
    let client!: LspStdioClient;
    let initializeResult!: Record<string, unknown>;

    async function openDocument(uri: string, languageId: string, text: string): Promise<DiagnosticShape[]> {
        const cursor = client.notificationCount;
        client.notify('textDocument/didOpen', {
            textDocument: { uri, languageId, version: 1, text },
        });
        const publication = await client.waitForNotification(
            'textDocument/publishDiagnostics',
            params => asRecord(params).uri === uri,
            DIAGNOSTICS_TIMEOUT_MS,
            cursor,
        );
        return diagnosticsOf(publication.params);
    }

    async function changeDocument(uri: string, version: number, text: string): Promise<DiagnosticShape[]> {
        const cursor = client.notificationCount;
        client.notify('textDocument/didChange', {
            textDocument: { uri, version },
            contentChanges: [{ text }],
        });
        const publication = await client.waitForNotification(
            'textDocument/publishDiagnostics',
            params => asRecord(params).uri === uri,
            DIAGNOSTICS_TIMEOUT_MS,
            cursor,
        );
        return diagnosticsOf(publication.params);
    }

    async function closeDocument(uri: string): Promise<void> {
        const cursor = client.notificationCount;
        client.notify('textDocument/didClose', { textDocument: { uri } });
        const publication = await client.waitForNotification(
            'textDocument/publishDiagnostics',
            params => asRecord(params).uri === uri,
            DIAGNOSTICS_TIMEOUT_MS,
            cursor,
        );
        expect(diagnosticsOf(publication.params)).toEqual([]);
    }

    beforeAll(async () => {
        client = LspStdioClient.spawn(SERVER_BIN, [], { requestTimeoutMs: REQUEST_TIMEOUT_MS });
        initializeResult = await client.request<Record<string, unknown>>('initialize', {
            processId: process.pid,
            rootUri: null,
            clientInfo: { name: 'hdlsupport-softbrush-contract', version: '0.0.1' },
            capabilities: {
                general: { positionEncodings: ['utf-16'] },
                textDocument: {
                    publishDiagnostics: { relatedInformation: true },
                    semanticTokens: {
                        dynamicRegistration: false,
                        requests: { full: true },
                        tokenTypes: [],
                        tokenModifiers: [],
                        formats: ['relative'],
                    },
                },
            },
        });
        client.notify('initialized', {});
    });

    afterAll(async () => {
        const exit = await client.stop();
        expect(exit.code, `softbrush_ls stderr:\n${client.getStderrTail().join('\n')}`).toBe(0);
    });

    it('advertises the Tcl, SDC, and XDC editor capabilities used by the extension', () => {
        const capabilities = asRecord(initializeResult.capabilities);
        expect(capabilities.positionEncoding).toBe('utf-16');
        const sync = capabilities.textDocumentSync;
        expect(sync === 1 || asRecord(sync).change === 1).toBe(true);
        expect(capabilities.hoverProvider).toBe(true);
        expect(capabilities.documentSymbolProvider).toBe(true);
        expect(capabilities.workspaceSymbolProvider).toBe(true);
        expect(asRecord(capabilities.completionProvider).triggerCharacters).toEqual(['-']);

        const semanticTokens = asRecord(capabilities.semanticTokensProvider);
        expect(semanticTokens.full).toBe(true);
        const legend = asRecord(semanticTokens.legend);
        expect(asArray(legend.tokenTypes)).toEqual(expect.arrayContaining([
            'comment', 'string', 'number', 'variable', 'function', 'keyword', 'parameter',
        ]));
        expect(asArray(legend.tokenModifiers)).toContain('declaration');
        expect(asRecord(initializeResult.serverInfo).name).toBe('softbrush_ls');
    });

    it('handles open, change, and close while keeping vendor SDC/XDC commands non-fatal', async () => {
        const tclDiagnostics = await openDocument(TCL_URI, 'tcl', TCL_SOURCE);
        expect(tclDiagnostics).toEqual([]);

        const semanticTokens = asRecord(await client.request(
            'textDocument/semanticTokens/full',
            { textDocument: { uri: TCL_URI } },
        ));
        const tokenData = asArray(semanticTokens.data);
        expect(tokenData.length).toBeGreaterThan(0);
        expect(tokenData.length % 5).toBe(0);

        const sdcDiagnostics = await openDocument(SDC_URI, 'sdc', SDC_VENDOR_SOURCE);
        expect(sdcDiagnostics.some(diagnostic => diagnostic.severity === 1)).toBe(false);
        expect(sdcDiagnostics).toContainEqual(expect.objectContaining({
            code: 'constraint-unknown-command',
            severity: 4,
            source: 'softbrush_ls',
        }));

        const xdcDiagnostics = await openDocument(XDC_URI, 'xdc', XDC_VENDOR_SOURCE);
        expect(xdcDiagnostics.some(diagnostic => diagnostic.severity === 1)).toBe(false);
        expect(xdcDiagnostics).toContainEqual(expect.objectContaining({
            code: 'constraint-unknown-command',
            severity: 4,
            source: 'softbrush_ls',
        }));

        const hover = asRecord(await client.request('textDocument/hover', {
            textDocument: { uri: XDC_URI },
            position: { line: 1, character: 2 },
        }));
        expect(asRecord(hover.contents).value).toContain('Create a primary or virtual timing clock');

        const completion = asArray(await client.request('textDocument/completion', {
            textDocument: { uri: XDC_URI },
            position: { line: 1, character: 13 },
        }));
        const completionLabels = completion.map(item => asRecord(item).label);
        expect(completionLabels).toEqual(expect.arrayContaining(['create_clock', 'set_property']));

        const invalidDiagnostics = await changeDocument(SDC_URI, 2, INVALID_SOURCE);
        expect(invalidDiagnostics).toContainEqual(expect.objectContaining({
            code: 'tcl-syntax',
            severity: 1,
            source: 'softbrush_ls',
        }));

        const correctedDiagnostics = await changeDocument(SDC_URI, 3, SDC_VENDOR_SOURCE);
        expect(correctedDiagnostics.some(diagnostic => diagnostic.severity === 1)).toBe(false);

        await closeDocument(XDC_URI);
        await closeDocument(SDC_URI);
        await closeDocument(TCL_URI);
        await expect(client.request('textDocument/semanticTokens/full', {
            textDocument: { uri: TCL_URI },
        })).resolves.toBeNull();
    });
    it.each(Object.entries(TCL_HIGHLIGHT_SOURCES))(
        'colors %s TextMate tokens the same as Softbrush semantic tokens',
        async (dialect, source) => {
            const uri = `file:///tmp/hdlsupport-softbrush-highlight.${dialect}`;
            await openDocument(uri, dialect, source);
            const tokens = asRecord(await client.request('textDocument/semanticTokens/full', { textDocument: { uri } }));
            await closeDocument(uri);
            const lines = source.split('\n');
            const legend = asRecord(asRecord(asRecord(initializeResult.capabilities).semanticTokensProvider).legend);
            const semantic = semanticClasses(asArray(tokens.data) as number[], legend, lines);
            const grammarLines = await tokenize(`source.${dialect}`, lines);

            const mismatches = grammarLines.flatMap((grammarTokens, line) => grammarTokens.flatMap((token) => {
                const start = lines[line].indexOf(token.text, grammarTokens
                    .slice(0, grammarTokens.indexOf(token))
                    .reduce((offset, previous) => offset + previous.text.length, 0));
                const actual = textMateType(token.scopes);
                return [...token.text].flatMap((character, offset) => {
                    const expected = semantic.get(`${line}:${start + offset}`);
                    // The grammar may leave plain, but never miscolor, what it cannot
                    // classify per dialect: clock references, which Softbrush colors only
                    // after their declaration, and the delimiters around a declared clock
                    // name or a procedure's parameter list, which the dialects color differently.
                    const clockReference = expected?.type === 'variable' && !expected.declaration
                        && !expected.text.startsWith('$');
                    const delimiter = /["{}]/.test(character);
                    const leftPlain = actual === undefined && (clockReference || delimiter);
                    return /\s/.test(character) || expected?.type === actual || leftPlain
                        ? []
                        : [`${line + 1}:${start + offset + 1} ${JSON.stringify(token.text)}`
                            + ` softbrush=${expected?.type ?? 'none'} textmate=${actual ?? 'none'}`];
                });
            }));
            // One report per mismatched token keeps failures readable.
            expect([...new Set(mismatches.map((mismatch) => mismatch.replace(/^(\d+):\d+/, '$1')))]).toEqual([]);
        },
    );
});
