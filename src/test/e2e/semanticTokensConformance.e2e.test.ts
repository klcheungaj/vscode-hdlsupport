import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
    DDR_CTRL_SV_TEXT,
    TB_TOP_SV_TEXT,
    computeTreeChecksum,
    createRealProjectFixture,
    positionAt,
    type RealProjectFixture,
} from './fixtures/realProject';
import { LspStdioClient } from './helpers/lspClient';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_BIN = path.join(REPO_ROOT, 'server', 'linux-x64', 'llg_ls');

const READY_TIMEOUT_MS = 150_000;
const REQUEST_TIMEOUT_MS = 90_000;
const EXIT_TIMEOUT_MS = 10_000;
const READY_MESSAGE_FRAGMENT = 'language server ready';
// Replace include-defined parameter defaults with same-width literals so this
// buffer stays position-compatible and parses without any include context.
const OPENED_DDR_CTRL_SV_TEXT = DDR_CTRL_SV_TEXT
    .replaceAll('`DATA_W', '8      ')
    .replaceAll('`ADDR_W', '12     ');

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const IDENTIFIER_TOKEN_SPAN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NUMBER_TOKEN_SPAN = /^(?:[0-9][0-9A-Za-z_$']*|'[sS]?[bBoOdDhH]?|'[01xXzZ]|[xXzZ?]+)$/;
const OPERATOR_TOKEN_SPAN = /^[^A-Za-z0-9_$'"\s]+$/;
// Compiler directives keep their grave accent (lapligence docs/semantic_tokens.md ST-06).
const DIRECTIVE_TOKEN_SPAN = /^`[A-Za-z_][A-Za-z0-9_]*$/;

interface DecodedToken {
    index: number;
    line: number;
    startChar: number;
    length: number;
    tokenType: number;
    tokenModifiers: number;
}

interface StreamViolations {
    structural: string[];
    ordering: string[];
    legendBounds: string[];
    truthfulness: string[];
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
    console.info(`[skip] semanticTokensConformance e2e: staged binary missing or not executable at ${SERVER_BIN}`);
}
const describeIfBinary = binaryAvailable ? describe : describe.skip;

function asRecord(value: unknown): Record<string, unknown> {
    return (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

/**
 * Decodes a semantic-tokens delta stream implementing the LSP encoding rule
 * exactly: quintets are [deltaLine, deltaStartChar, length, tokenType,
 * tokenModifiers]; deltaLine accumulates across the stream; startChar is
 * relative to the PREVIOUS TOKEN's startChar only within the same line and
 * resets to the absolute column whenever the line advances. Seeding the
 * accumulator at (line=0, startChar=0) makes the first-token case exact.
 */
export function decodeSemanticTokens(data: number[]): DecodedToken[] {
    const tokens: DecodedToken[] = [];
    let line = 0;
    let startChar = 0;
    for (let i = 0; i + 5 <= data.length; i += 5) {
        const deltaLine = data[i];
        const deltaStart = data[i + 1];
        const length = data[i + 2];
        const tokenType = data[i + 3];
        const tokenModifiers = data[i + 4];
        if (deltaLine > 0) {
            line += deltaLine;
            startChar = deltaStart; // new line: absolute column
        } else {
            startChar += deltaStart; // same line: relative to previous token
        }
        tokens.push({ index: i / 5, line, startChar, length, tokenType, tokenModifiers });
    }
    return tokens;
}

/** Splits raw file text into LSP lines, dropping one trailing \r per line so
 *  CRLF files slice identically to LF ones (LSP positions exclude EOL). */
function splitLines(text: string): string[] {
    return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** Classifies an implausible span so reports say WHERE tokens land, not just that they miss. */
function classifySpan(sliced: string): string {
    if (sliced.length === 0) {
        return 'empty span';
    }
    if (/^\s+$/.test(sliced)) {
        return 'whitespace';
    }
    if (/^[0-9][0-9A-Za-z_$']*$/.test(sliced)) {
        return 'numeric literal';
    }
    if (/^[^A-Za-z0-9_$]+$/.test(sliced)) {
        return 'operator/punctuation';
    }
    if (IDENTIFIER_TOKEN_SPAN.test(sliced.trim())) {
        return 'identifier padded with whitespace';
    }
    return 'partial identifier / mixed span';
}

function isPlausibleTokenSpan(sliced: string, tokenType: string): boolean {
    if (sliced.length === 0 || /^\s+$/.test(sliced)) {
        return false;
    }
    if (tokenType === 'number') {
        return NUMBER_TOKEN_SPAN.test(sliced);
    }
    if (tokenType === 'operator') {
        return OPERATOR_TOKEN_SPAN.test(sliced);
    }
    if (tokenType === 'keyword' && DIRECTIVE_TOKEN_SPAN.test(sliced)) {
        return true;
    }
    if (tokenType === 'comment' || tokenType === 'string' || tokenType === 'regexp') {
        return true;
    }
    return IDENTIFIER_TOKEN_SPAN.test(sliced);
}

/**
 * Full wire-format validation of one semanticTokens stream against its file
 * text and the server-declared legend. Every violation is collected (never
 * early-exit) so the failure report shows the complete anomaly set.
 */
export function validateTokenStream(
    text: string,
    data: number[],
    legendTokenTypes: string[],
    legendTokenModifiers: string[],
): StreamViolations {
    const violations: StreamViolations = { structural: [], ordering: [], legendBounds: [], truthfulness: [] };
    const lines = splitLines(text);

    if (data.length % 5 !== 0) {
        violations.structural.push(`data.length=${data.length} is not a multiple of 5`);
    }

    const tokens = decodeSemanticTokens(data);
    for (const token of tokens) {
        if (token.length < 1) {
            violations.ordering.push(`token #${token.index} has length ${token.length}`);
        }
        if (token.tokenType < 0 || token.tokenType >= legendTokenTypes.length) {
            violations.legendBounds.push(
                `token #${token.index} typeIndex=${token.tokenType} outside legend (${legendTokenTypes.length} types)`,
            );
        }
        const maxModifierSet = Math.floor(token.tokenModifiers / 2 ** legendTokenModifiers.length);
        if (token.tokenModifiers < 0 || maxModifierSet !== 0) {
            violations.legendBounds.push(
                `token #${token.index} modifierBits=${token.tokenModifiers} exceeds ${legendTokenModifiers.length} declared modifiers`,
            );
        }
    }

    for (let i = 1; i < tokens.length; i++) {
        const previous = tokens[i - 1];
        const current = tokens[i];
        if (current.line < previous.line) {
            violations.ordering.push(`token #${current.index} line ${current.line} precedes #${previous.index} line ${previous.line}`);
        } else if (current.line === previous.line) {
            if (current.startChar < previous.startChar) {
                violations.ordering.push(
                    `token #${current.index} startChar ${current.startChar} < #${previous.index} startChar ${previous.startChar} on line ${current.line}`,
                );
            } else if (previous.startChar + previous.length > current.startChar) {
                violations.ordering.push(
                    `token #${current.index} overlaps #${previous.index} on line ${current.line} ` +
                    `([${current.startChar},${current.startChar + current.length}) vs [${previous.startChar},${previous.startChar + previous.length}))`,
                );
            }
        }
    }

    for (const token of tokens) {
        const lineText = lines[token.line];
        if (lineText === undefined) {
            violations.truthfulness.push(
                `token #${token.index} points at line ${token.line} but file has ${lines.length} lines`,
            );
            continue;
        }
        if (token.startChar + token.length > lineText.length) {
            violations.truthfulness.push(
                `token #${token.index} [${token.startChar},${token.startChar + token.length}) extends past end of line ${token.line}: ${JSON.stringify(lineText)}`,
            );
            continue;
        }
        const sliced = lineText.slice(token.startChar, token.startChar + token.length);
        const tokenType = legendTokenTypes[token.tokenType] ?? String(token.tokenType);
        if (!isPlausibleTokenSpan(sliced, tokenType)) {
            violations.truthfulness.push(
                `token #${token.index} (type '${tokenType}') lands on ${classifySpan(sliced)}: ` +
                `${JSON.stringify(sliced)} at line ${token.line}:${token.startChar}`,
            );
        }
    }

    return violations;
}

function assertNoViolations(section: string, violations: string[]): void {
    expect(violations).toEqual([]);
    // Unreachable when green; keeps failure messages readable when red.
    if (violations.length > 0) {
        throw new Error(`${section}: ${violations.join(' | ')}`);
    }
}

describeIfBinary('llg semantic tokens wire-format conformance (staged binary)', () => {
    let client!: LspStdioClient;
    let fixture!: RealProjectFixture;
    let initializeResult!: Record<string, unknown>;
    let legendTokenTypes: string[] = [];
    let legendTokenModifiers: string[] = [];
    let documentVersion = 1;

    /** Opens a document like a real user would and settles analysis for it. */
    async function openAndSettle(uri: string, languageId: string, text: string): Promise<void> {
        documentVersion += 1;
        client.notify('textDocument/didOpen', {
            textDocument: { uri, languageId, version: documentVersion, text },
        });
        // A clean document may have no diagnostic publication at all: llg
        // suppresses unchanged empty diagnostics, and project-wide startup
        // analysis need not emit an empty notification for every file. A
        // request sent after didOpen is the reliable synchronization point;
        // the server processes the notification before this queued request.
        await client.request(
            'textDocument/documentSymbol',
            { textDocument: { uri } },
            REQUEST_TIMEOUT_MS,
        );
    }

    async function fetchSemanticTokens(uri: string): Promise<number[]> {
        const result = await client.request<Record<string, unknown>>(
            'textDocument/semanticTokens/full',
            { textDocument: { uri } },
            REQUEST_TIMEOUT_MS,
        );
        return asArray(asRecord(result).data) as number[];
    }

    function logDecodedSample(label: string, text: string, data: number[]): void {
        const lines = splitLines(text);
        const tokens = decodeSemanticTokens(data);
        const preview = tokens.slice(0, 24).map((token) => {
            const lineText = lines[token.line] ?? '';
            const sliced = lineText.slice(token.startChar, token.startChar + token.length);
            const typeName = legendTokenTypes[token.tokenType] ?? `?${token.tokenType}`;
            const modNames = legendTokenModifiers.filter((_, bit) => (token.tokenModifiers & (1 << bit)) !== 0);
            return `#${token.index} ${token.line}:${token.startChar} len=${token.length} '${sliced}' type=${typeName}${modNames.length > 0 ? ` mods=[${modNames.join(',')}]` : ''}`;
        });
        console.info(
            `[semanticTokens ${label}] legend.types=[${legendTokenTypes.join(', ')}]\n` +
            `[semanticTokens ${label}] legend.modifiers=[${legendTokenModifiers.join(', ')}]\n` +
            `[semanticTokens ${label}] tokens=${tokens.length}\n` +
            preview.map((entry) => `  ${entry}`).join('\n'),
        );
    }

    beforeAll(async () => {
        // CLEAN-project variant: no deliberate error, so the whole-project
        // analysis can go valid and token streams actually flow. This suite
        // isolates wire-format conformance from last-good snapshot gating.
        fixture = createRealProjectFixture({ injectError: false });
        client = LspStdioClient.spawn(SERVER_BIN, [], {
            cwd: fixture.projectDir,
            env: { ...process.env, LLG_LOG: process.env.LLG_LOG ?? 'warn' },
        });

        initializeResult = await client.request<Record<string, unknown>>(
            'initialize',
            {
                processId: process.pid,
                rootUri: null,
                workspaceFolders: [{ uri: fixture.projectUri, name: 'proj' }],
                clientInfo: { name: 'hdlsupport-e2e-semconf', version: '0.0.1' },
                capabilities: {
                    workspace: { configuration: true, workspaceFolders: true },
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
        await client.waitForNotification(
            'window/logMessage',
            (params) => {
                const message = asRecord(params).message;
                return typeof message === 'string' && message.includes(READY_MESSAGE_FRAGMENT);
            },
            READY_TIMEOUT_MS,
            0,
        );

        const provider = asRecord(asRecord(initializeResult.capabilities).semanticTokensProvider);
        const legend = asRecord(provider.legend);
        legendTokenTypes = asArray(legend.tokenTypes).map(String);
        legendTokenModifiers = asArray(legend.tokenModifiers).map(String);

        // The in-memory revision is self-contained and differs from disk,
        // proving that the isolated open-buffer path wins over project cache.
        await openAndSettle(fixture.ddrCtrlUri, 'systemverilog', OPENED_DDR_CTRL_SV_TEXT);
    }, 175_000);

    describe('rtl/ddr_ctrl.sv — opened known-clean file', () => {
        let data: number[] = [];

        beforeAll(async () => {
            data = await fetchSemanticTokens(fixture.ddrCtrlUri);
            logDecodedSample('ddr_ctrl.sv', OPENED_DDR_CTRL_SV_TEXT, data);
        }, REQUEST_TIMEOUT_MS + 10_000);

        it('returns non-empty token data for a clean OPENED file', () => {
            expect(data.length).toBeGreaterThan(0);
        });

        it('encodes whole quintets: data.length % 5 === 0', () => {
            expect(data.length % 5).toBe(0);
        });

        it('delta-encodes tokens sorted by (line, startChar) exactly per the LSP spec', () => {
            expect(data.length).toBeGreaterThan(0); // nothing to decode otherwise
            const violations = validateTokenStream(OPENED_DDR_CTRL_SV_TEXT, data, legendTokenTypes, legendTokenModifiers);
            assertNoViolations('ordering', violations.ordering);
            assertNoViolations('structural', violations.structural);
        });

        it('keeps every tokenType index and modifier bitset within the declared legend', () => {
            expect(data.length).toBeGreaterThan(0);
            const violations = validateTokenStream(OPENED_DDR_CTRL_SV_TEXT, data, legendTokenTypes, legendTokenModifiers);
            assertNoViolations('legendBounds', violations.legendBounds);
        });

        it('[position-truthful] every token slices text appropriate for its advertised type', () => {
            expect(data.length).toBeGreaterThan(0);
            const violations = validateTokenStream(OPENED_DDR_CTRL_SV_TEXT, data, legendTokenTypes, legendTokenModifiers);
            assertNoViolations('truthfulness', violations.truthfulness);
        });

        it("types the 'module' keyword as a keyword-ish class and 'ddr_ctrl' occurrences as identifier-ish classes", () => {
            expect(data.length).toBeGreaterThan(0);
            const tokens = decodeSemanticTokens(data);
            const lines = splitLines(OPENED_DDR_CTRL_SV_TEXT);

            const modulePos = positionAt(OPENED_DDR_CTRL_SV_TEXT, 'module ddr_ctrl', 0);
            const keywordishIndex = findLegendIndex(/^(keyword|type)$/i);
            expect(keywordishIndex).toBeGreaterThanOrEqual(0);
            const moduleToken = tokens.find(
                (token) =>
                    token.line === modulePos.line &&
                    token.startChar <= modulePos.character &&
                    token.startChar + token.length >= modulePos.character + 'module'.length &&
                    lines[token.line]?.slice(token.startChar, token.startChar + token.length) === 'module',
            );
            if (moduleToken === undefined) {
                // Crisp finding instead of a bare toBeDefined() mismatch.
                const lineTokens = tokens.filter((token) => token.line === modulePos.line);
                throw new Error(
                    `no semantic token covers the 'module' keyword at ${modulePos.line}:${modulePos.character} ` +
                    `(line ${modulePos.line} tokens: ${JSON.stringify(lineTokens)}); ` +
                    `note 'endmodule' IS tokenized as keyword elsewhere — inconsistent keyword coverage`,
                );
            }
            const moduleName = legendTokenTypes[moduleToken?.tokenType ?? -1] ?? '';
            expect(moduleName).toMatch(/^(keyword|type)$/i);

            const ddrCtrlTokens = tokens.filter((token) => {
                const sliced = lines[token.line]?.slice(token.startChar, token.startChar + token.length);
                return sliced === 'ddr_ctrl';
            });
            expect(ddrCtrlTokens.length).toBeGreaterThanOrEqual(1);
            const misTyped = ddrCtrlTokens
                .map((token) => legendTokenTypes[token.tokenType] ?? String(token.tokenType))
                .filter((name) => /keyword|comment|string|operator|punctuation|whitespace|regexp/i.test(name));
            expect(misTyped).toEqual([]);
        });
    });

    describe('tb/tb_top.sv — opened CRLF file (production wrinkle)', () => {
        let data: number[] = [];

        beforeAll(async () => {
            await openAndSettle(fixture.tbTopUri, 'systemverilog', TB_TOP_SV_TEXT);
            data = await fetchSemanticTokens(fixture.tbTopUri);
            logDecodedSample('tb_top.sv', TB_TOP_SV_TEXT, data);
        }, REQUEST_TIMEOUT_MS + 10_000);

        it('returns non-empty token data for the opened CRLF file', () => {
            expect(data.length).toBeGreaterThan(0);
        });

        it('survives full strict validation despite CRLF endings', () => {
            expect(data.length).toBeGreaterThan(0);
            const violations = validateTokenStream(TB_TOP_SV_TEXT, data, legendTokenTypes, legendTokenModifiers);
            assertNoViolations('structural', violations.structural);
            assertNoViolations('ordering', violations.ordering);
            assertNoViolations('legendBounds', violations.legendBounds);
            assertNoViolations('truthfulness', violations.truthfulness);
        });

        it("types the 'module' keyword as a keyword-ish class", () => {
            expect(data.length).toBeGreaterThan(0);
            const tokens = decodeSemanticTokens(data);
            const lines = splitLines(TB_TOP_SV_TEXT);
            const modulePos = positionAt(TB_TOP_SV_TEXT, 'module tb_top;', 0);
            const moduleToken = tokens.find(
                (token) =>
                    token.line === modulePos.line &&
                    lines[token.line]?.slice(token.startChar, token.startChar + token.length) === 'module',
            );
            if (moduleToken === undefined) {
                throw new Error(
                    `no semantic token covers the 'module' keyword at ${modulePos.line}:${modulePos.character} ` +
                    `(while the trailing 'endmodule' IS tokenized as keyword)`,
                );
            }
            const moduleName = legendTokenTypes[moduleToken?.tokenType ?? -1] ?? '';
            expect(moduleName).toMatch(/^(keyword|type)$/i);
        });
    });

    it('keeps the fixture read-only and exits cleanly', async () => {
        const exitInfo = await client.stop(EXIT_TIMEOUT_MS);
        expect(exitInfo.code === 0 || exitInfo.code === null).toBe(true);
        expect(computeTreeChecksum(fixture.projectDir)).toBe(fixture.checksum);
    });

    afterAll(async () => {
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

    function findLegendIndex(pattern: RegExp): number {
        return legendTokenTypes.findIndex((name) => pattern.test(name));
    }
});
