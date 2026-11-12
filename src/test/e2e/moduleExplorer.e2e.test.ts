// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
    computeTreeChecksum,
    createRealProjectFixture,
    type RealProjectFixture,
} from './fixtures/realProject';
import { LspStdioClient } from './helpers/lspClient';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_BIN = path.join(REPO_ROOT, 'server', 'linux-x64', 'llg_ls');

const READY_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 15_000;
const READY_MESSAGE_FRAGMENT = 'language server ready';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

interface ExplorerParameter {
    readonly name: string;
    readonly type?: ExplorerType;
    readonly value?: string | null;
    readonly detail?: string | null;
    readonly location?: ExplorerLocation | null;
}

interface ExplorerType {
    readonly kind: string;
    readonly width?: number | null;
    readonly signed?: boolean;
    readonly typeName?: string | null;
    readonly displayType?: string | null;
}

interface ExplorerLocation {
    readonly uri: string;
    readonly range: ExplorerRange;
}

interface ExplorerPort {
    readonly name: string;
    readonly direction?: string;
    readonly detail?: string | null;
    readonly type?: ExplorerType;
    readonly location?: ExplorerLocation | null;
}

interface ExplorerSignal {
    readonly name: string;
    readonly kind?: string;
    readonly detail?: string | null;
    readonly type?: ExplorerType;
    readonly location?: ExplorerLocation | null;
}

interface ExplorerRange {
    readonly startLine: number;
    readonly startCharacter: number;
    readonly endLine: number;
    readonly endCharacter: number;
}

interface ExplorerDocumentSymbol {
    readonly name: string;
    readonly range: {
        readonly start: { readonly line: number; readonly character: number };
        readonly end: { readonly line: number; readonly character: number };
    };
    readonly children?: readonly ExplorerDocumentSymbol[];
}

interface ExplorerNode {
    readonly id?: string;
    readonly instanceName?: string;
    readonly moduleType?: string;
    readonly definitionId?: string | null;
    readonly uri?: string | null;
    readonly range?: ExplorerRange | null;
    readonly contentSource?: string;
    readonly isCycleTruncated?: boolean;
    readonly isBudgetTruncated?: boolean;
    readonly params?: readonly ExplorerParameter[];
    readonly ports?: readonly ExplorerPort[];
    readonly signals?: readonly ExplorerSignal[];
    readonly children: readonly ExplorerNode[];
}

interface ExplorerModule {
    readonly id?: string;
    readonly name: string;
    readonly uri?: string | null;
    readonly range?: ExplorerRange | null;
    readonly contentSource?: string;
    readonly ports?: readonly ExplorerPort[];
    readonly params?: readonly ExplorerParameter[];
    readonly signals?: readonly ExplorerSignal[];
}

type ExplorerContent = ExplorerParameter | ExplorerPort | ExplorerSignal;

interface ExplorerSnapshot {
    readonly modules: readonly ExplorerModule[];
    readonly roots: readonly ExplorerNode[];
}

interface ExplorerSession {
    readonly client: LspStdioClient;
    readonly fixture: RealProjectFixture;
    readonly snapshot: ExplorerSnapshot;
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
    console.info(`[skip] moduleExplorer e2e: staged binary missing or not executable at ${SERVER_BIN}`);
}
const describeIfBinary = binaryAvailable ? describe : describe.skip;

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function moduleExplorerSnapshot(value: unknown): ExplorerSnapshot {
    const record = asRecord(value);
    expect(Array.isArray(record.modules)).toBe(true);
    expect(Array.isArray(record.roots)).toBe(true);
    return {
        modules: record.modules as ExplorerModule[],
        roots: record.roots as ExplorerNode[],
    };
}

function nodeName(node: ExplorerNode): string {
    return node.moduleType ?? node.instanceName ?? '';
}

function findNode(nodes: readonly ExplorerNode[], predicate: (node: ExplorerNode) => boolean): ExplorerNode {
    const node = nodes.find(predicate);
    expect(node).toBeDefined();
    return node as ExplorerNode;
}

function collectNodes(nodes: readonly ExplorerNode[]): ExplorerNode[] {
    return nodes.flatMap((node) => [node, ...collectNodes(node.children)]);
}

function parameter(node: ExplorerNode, name: string): ExplorerParameter {
    const value = node.params?.find((candidate) => candidate.name === name);
    expect(value).toBeDefined();
    return value as ExplorerParameter;
}

function port(node: ExplorerNode, name: string): ExplorerPort {
    const value = node.ports?.find((candidate) => candidate.name === name);
    expect(value).toBeDefined();
    return value as ExplorerPort;
}

function signal(node: ExplorerNode, name: string): ExplorerSignal {
    const value = node.signals?.find((candidate) => candidate.name === name);
    expect(value).toBeDefined();
    return value as ExplorerSignal;
}

function moduleDefinition(snapshot: ExplorerSnapshot, node: ExplorerNode): ExplorerModule {
    const definition = snapshot.modules.find((candidate) => candidate.id === node.definitionId);
    expect(definition).toBeDefined();
    return definition as ExplorerModule;
}

function sourceRange(value: ExplorerRange | null | undefined, context: string): ExplorerRange {
    expect(value).toBeDefined();
    const range = value as ExplorerRange;
    for (const [name, coordinate] of [
        ['startLine', range.startLine],
        ['startCharacter', range.startCharacter],
        ['endLine', range.endLine],
        ['endCharacter', range.endCharacter],
    ] as const) {
        expect(Number.isInteger(coordinate)).toBe(true);
        expect(coordinate).toBeGreaterThanOrEqual(0);
        if (!Number.isInteger(coordinate) || coordinate < 0) {
            throw new Error(`${context} has invalid ${name}`);
        }
    }
    expect(range.endLine).toBeGreaterThanOrEqual(range.startLine);
    if (range.endLine === range.startLine) {
        expect(range.endCharacter).toBeGreaterThanOrEqual(range.startCharacter);
    }
    return range;
}

function declarationLocation(
    module: ExplorerModule,
    entry: ExplorerContent,
): { uri: string; range: ExplorerRange } {
    expect(entry.location).toBeDefined();
    const location = entry.location as ExplorerLocation;
    expect(location.uri).toEqual(expect.any(String));
    expect(location.uri).not.toBe('');
    return {
        uri: location.uri,
        range: sourceRange(location.range, `${module.name}.${entry.name}`),
    };
}

function assertContentDeclarationMetadata(
    module: ExplorerModule,
    expectedUri: string,
    entries: readonly ExplorerContent[],
): void {
    expect(module.uri).toBe(expectedUri);
    sourceRange(module.range, `${module.name} declaration`);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
        expect(declarationLocation(module, entry).uri).toBe(expectedUri);
    }
}

function exactDeclarationLocation(
    entry: ExplorerContent,
    expectedUri: string,
    expectedRange: ExplorerRange,
    sourcePath: string,
): void {
    expect(declarationLocation({ name: entry.name, uri: expectedUri, range: expectedRange }, entry)).toEqual({
        uri: expectedUri,
        range: expectedRange,
    });
    const sourceLines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
    const line = sourceLines[expectedRange.startLine];
    expect(line).toBeDefined();
    expect(line?.slice(expectedRange.startCharacter, expectedRange.endCharacter)).toBe(entry.name);
}

function exactDisplayType(entry: ExplorerContent, context: string): string {
    expect(entry.type).toBeDefined();
    expect(entry.type?.displayType).toEqual(expect.any(String));
    const displayType = entry.type?.displayType;
    if (typeof displayType !== 'string') {
        throw new Error(`${context} is missing type.displayType`);
    }
    return displayType;
}

function exactHierarchyLocation(
    node: ExplorerNode,
    expectedUri: string,
    expectedRange: ExplorerRange,
    sourcePath: string,
    expectedText: string,
): void {
    expect(node.instanceName).toEqual(expect.any(String));
    expect(node.uri).toBe(expectedUri);
    expect(node.range).toEqual(expectedRange);
    const sourceLines = fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/);
    const line = sourceLines[expectedRange.startLine];
    expect(line).toBeDefined();
    expect(line?.slice(expectedRange.startCharacter, expectedRange.endCharacter)).toBe(expectedText);
}

function assertExactDeclarationLocations(
    entries: readonly ExplorerContent[],
    expectedUri: string,
    sourcePath: string,
    expectedRanges: Readonly<Record<string, ExplorerRange>>,
    instance?: ExplorerNode,
    definition?: ExplorerModule,
): void {
    for (const entry of entries) {
        const expectedRange = expectedRanges[entry.name];
        expect(expectedRange).toBeDefined();
        if (expectedRange === undefined) {
            throw new Error(`missing expected range for ${entry.name}`);
        }
        exactDeclarationLocation(entry, expectedUri, expectedRange, sourcePath);
        const location = declarationLocation({ name: 'expected module' }, entry);
        if (instance?.uri && instance.range) {
            expect(location).not.toEqual({ uri: instance.uri, range: instance.range });
        }
        if (definition?.uri && definition.range) {
            expect(location).not.toEqual({ uri: definition.uri, range: definition.range });
        }
    }
}

function findDocumentSymbol(
    symbols: readonly ExplorerDocumentSymbol[],
    name: string,
): ExplorerDocumentSymbol | undefined {
    for (const symbol of symbols) {
        if (symbol.name === name) {
            return symbol;
        }
        const nested = findDocumentSymbol(symbol.children ?? [], name);
        if (nested) {
            return nested;
        }
    }
    return undefined;
}

async function assertDocumentDeclarationMetadata(
    client: LspStdioClient,
    uri: string,
    entries: readonly ExplorerContent[],
): Promise<void> {
    const raw = await client.request<unknown>(
        'textDocument/documentSymbol',
        { textDocument: { uri } },
        REQUEST_TIMEOUT_MS,
    );
    expect(Array.isArray(raw)).toBe(true);
    const symbols = raw as ExplorerDocumentSymbol[];
    expect(uri).toMatch(/^file:/);
    for (const entry of entries) {
        const symbol = findDocumentSymbol(symbols, entry.name);
        expect(symbol).toBeDefined();
        const value = symbol as ExplorerDocumentSymbol;
        const range = sourceRange({
            startLine: value.range.start.line,
            startCharacter: value.range.start.character,
            endLine: value.range.end.line,
            endCharacter: value.range.end.character,
        }, `${uri} declaration ${entry.name}`);
        expect(range.endLine).toBeGreaterThanOrEqual(range.startLine);
    }
}

function validateFixtureManifest(fixture: RealProjectFixture): void {
    // The helper owns all workspace creation. This check pins the v1 manifest
    // and source inventory without creating a second ad-hoc fixture here.
    const manifest = fs.readFileSync(fixture.configPath, 'utf8');
    expect(manifest).toContain('schema_version = 1');
    expect(manifest).toContain('[sources]');
    expect(manifest).toContain('directories = ["."]');
    expect(manifest).toContain('include = ["**/*.v", "**/*.sv"]');
    for (const [filePath, moduleName] of [
        [fixture.topPath, 'module top'],
        [fixture.ddrCtrlPath, 'module ddr_ctrl'],
        [fixture.typeShapesPath, 'module type_shapes'],
        [fixture.typeShapesPath, 'module type_shapes_decl_only'],
        [fixture.deepModPath, 'module deep_mod'],
        [fixture.tbTopPath, 'module tb_top'],
    ] as const) {
        expect(fs.readFileSync(filePath, 'utf8')).toContain(moduleName);
    }
}

function startSession(compileTop?: string, includeFooRepro = false): Promise<ExplorerSession> {
    const fixture = createRealProjectFixture(
        {
            injectError: false,
            ...(compileTop === undefined ? {} : { compileTop }),
            ...(includeFooRepro ? { includeFooRepro: true } : {}),
        },
        includeFooRepro
            ? 'hdlsupport-e2e-explorer-foo'
            : compileTop === undefined
                ? 'hdlsupport-e2e-explorer-auto'
                : 'hdlsupport-e2e-explorer-configured',
    );
    validateFixtureManifest(fixture);
    const client = LspStdioClient.spawn(SERVER_BIN, [], {
        cwd: fixture.projectDir,
        env: { ...process.env, LLG_LOG: 'warn' },
    });

    return (async (): Promise<ExplorerSession> => {
        try {
            const initializedNotificationCursor = client.notificationCount;
            await client.request(
                'initialize',
                {
                    processId: process.pid,
                    rootUri: null,
                    workspaceFolders: [{ uri: fixture.projectUri, name: 'proj' }],
                    clientInfo: { name: 'hdlsupport-e2e-module-explorer', version: '0.0.1' },
                    capabilities: {
                        workspace: {
                            configuration: true,
                            workspaceFolders: true,
                        },
                        textDocument: {
                            publishDiagnostics: { relatedInformation: true },
                            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
                        },
                    },
                    initializationOptions: {
                        llg: {
                            protocolVersion: 1,
                            configFiles: [{ workspaceUri: fixture.projectUri, path: fixture.configPath }],
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
            await client.waitForNotification(
                'llg/moduleExplorerChanged',
                undefined,
                READY_TIMEOUT_MS,
                initializedNotificationCursor,
            );
            const snapshot = moduleExplorerSnapshot(await client.request<unknown>(
                'llg/moduleExplorer',
                {},
                REQUEST_TIMEOUT_MS,
            ));
            return { client, fixture, snapshot };
        } catch (error) {
            if (!client.exited) {
                await client.stop(EXIT_TIMEOUT_MS).catch(() => undefined);
            }
            fixture.dispose();
            throw error;
        }
    })();
}

async function stopSession(session: ExplorerSession | undefined): Promise<void> {
    if (session === undefined) {
        return;
    }
    try {
        if (!session.client.exited) {
            const exitInfo = await session.client.stop(EXIT_TIMEOUT_MS);
            expect(exitInfo.code === 0 || exitInfo.code === null).toBe(true);
        }
        expect(computeTreeChecksum(session.fixture.projectDir)).toBe(session.fixture.checksum);
    } finally {
        session.fixture.dispose();
    }
}

describeIfBinary('llg module explorer end-to-end (staged binary)', () => {
    describe('with automatically inferred roots', () => {
        let session: ExplorerSession | undefined;

        beforeAll(async () => {
            session = await startSession();
        }, 180_000);

        it('returns every uninstantiated definition while omitting inferred child/leaf roots', () => {
            const roots = session?.snapshot.roots ?? [];
            const rootNames = roots.map(nodeName).sort();
            expect(rootNames).toEqual(['deep_mod', 'tb_top', 'type_shapes_decl_only']);
            expect(rootNames).not.toContain('top');
            expect(rootNames).not.toContain('ddr_ctrl');
            expect(rootNames).not.toContain('type_shapes');
        });

        it('keeps exact recursive elaborated contents, resolved widths, and declaration metadata', async () => {
            const roots = session?.snapshot.roots ?? [];
            const tbTop = findNode(roots, (node) => nodeName(node) === 'tb_top');
            const top = findNode(tbTop.children, (node) => node.instanceName === 'u_top');
            const ddrCtrl = findNode(top.children, (node) => node.instanceName === 'u_ddr_ctrl');
            const wideDdrCtrl = findNode(top.children, (node) => node.instanceName === 'u_ddr_ctrl_wide');
            const typeShapesDefault = findNode(
                top.children,
                (node) => node.instanceName === 'u_type_shapes_default',
            );
            const typeShapesWide = findNode(
                top.children,
                (node) => node.instanceName === 'u_type_shapes_wide',
            );
            const snapshot = session?.snapshot as ExplorerSnapshot;
            const ddrDefinition = moduleDefinition(snapshot, ddrCtrl);
            const typeShapesDefinition = moduleDefinition(snapshot, typeShapesDefault);

            expect(ddrCtrl.moduleType).toBe('ddr_ctrl');
            expect(ddrCtrl.id).toMatch(/^instance:/);
            expect(ddrCtrl.id).toContain('tb_top.u_top.u_ddr_ctrl');
            expect(ddrCtrl.definitionId).toEqual(expect.any(String));
            expect(ddrCtrl.contentSource).toBe('elaborated');
            expect(wideDdrCtrl.moduleType).toBe('ddr_ctrl');
            expect(wideDdrCtrl.instanceName).toBe('u_ddr_ctrl_wide');
            expect(wideDdrCtrl.id).toMatch(/^instance:/);
            expect(wideDdrCtrl.id).toContain('tb_top.u_top.u_ddr_ctrl_wide');
            expect(wideDdrCtrl.id).not.toBe(ddrCtrl.id);
            expect(wideDdrCtrl.definitionId).toBe(ddrCtrl.definitionId);
            expect(wideDdrCtrl.contentSource).toBe('elaborated');
            expect(wideDdrCtrl.uri).toBe(session?.fixture.topUri);
            expect(wideDdrCtrl.range).not.toEqual(ddrCtrl.range);
            exactHierarchyLocation(
                ddrCtrl,
                session?.fixture.topUri ?? '',
                { startLine: 16, startCharacter: 4, endLine: 16, endCharacter: 12 },
                session?.fixture.topPath ?? '',
                'ddr_ctrl',
            );
            exactHierarchyLocation(
                wideDdrCtrl,
                session?.fixture.topUri ?? '',
                { startLine: 28, startCharacter: 4, endLine: 28, endCharacter: 12 },
                session?.fixture.topPath ?? '',
                'ddr_ctrl',
            );
            expect(typeShapesDefault.moduleType).toBe('type_shapes');
            expect(typeShapesWide.moduleType).toBe('type_shapes');
            expect(typeShapesDefault.id).toMatch(/^instance:/);
            expect(typeShapesWide.id).toMatch(/^instance:/);
            expect(typeShapesDefault.id).not.toBe(typeShapesWide.id);
            expect(typeShapesDefault.definitionId).toBe(typeShapesWide.definitionId);
            expect(typeShapesDefault.contentSource).toBe('elaborated');
            expect(typeShapesWide.contentSource).toBe('elaborated');
            exactHierarchyLocation(
                typeShapesDefault,
                session?.fixture.topUri ?? '',
                { startLine: 41, startCharacter: 4, endLine: 41, endCharacter: 15 },
                session?.fixture.topPath ?? '',
                'type_shapes',
            );
            exactHierarchyLocation(
                typeShapesWide,
                session?.fixture.topUri ?? '',
                { startLine: 46, startCharacter: 4, endLine: 46, endCharacter: 15 },
                session?.fixture.topPath ?? '',
                'type_shapes',
            );
            expect(ddrCtrl.ports?.map((port) => port.name)).toEqual(expect.arrayContaining([
                'clk', 'rst_n', 'wr_en', 'wdata', 'rdata', 'ready',
            ]));
            expect(ddrCtrl.ports).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    name: 'clk',
                    direction: 'input',
                    type: expect.objectContaining({ kind: 'logic' }),
                }),
                expect.objectContaining({
                    name: 'rdata',
                    direction: 'output',
                    type: expect.objectContaining({ kind: 'logic', width: 8 }),
                }),
            ]));
            const rdata = port(ddrCtrl, 'rdata');
            expect(exactDisplayType(rdata, 'ddr_ctrl.rdata')).toBe('logic [7:0]');
            expect(rdata?.detail ?? '').not.toContain('DATA_W-1:0');
            expect(ddrCtrl.signals?.map((signal) => signal.name)).toEqual(expect.arrayContaining(['addr_q', 'busy_q']));
            expect(ddrCtrl.signals).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    name: 'addr_q',
                    kind: 'var',
                    type: expect.objectContaining({ kind: 'logic', width: 12 }),
                }),
                expect.objectContaining({
                    name: 'busy_q',
                    kind: 'var',
                    type: expect.objectContaining({ kind: 'logic' }),
                }),
            ]));
            const dataWidth = parameter(ddrCtrl, 'DATA_W');
            expect(dataWidth.type).toEqual(expect.objectContaining({ kind: 'int' }));
            expect(dataWidth.value).toEqual(expect.stringContaining('8'));
            expect(dataWidth.value).not.toContain('DATA_W');

            expect(exactDisplayType(dataWidth, 'ddr_ctrl.DATA_W')).toBe('int');
            expect(exactDisplayType(parameter(ddrCtrl, 'ADDR_W'), 'ddr_ctrl.ADDR_W')).toBe('int');
            expect(exactDisplayType(parameter(ddrCtrl, 'LANES'), 'ddr_ctrl.LANES')).toBe('int');
            expect(exactDisplayType(port(ddrCtrl, 'clk'), 'ddr_ctrl.clk')).toBe('logic');
            expect(exactDisplayType(port(ddrCtrl, 'rst_n'), 'ddr_ctrl.rst_n')).toBe('logic');
            expect(exactDisplayType(port(ddrCtrl, 'wr_en'), 'ddr_ctrl.wr_en')).toBe('logic [3:0]');
            expect(exactDisplayType(port(ddrCtrl, 'wdata'), 'ddr_ctrl.wdata')).toBe('logic [7:0]');
            expect(exactDisplayType(rdata, 'ddr_ctrl.rdata')).toBe('logic [7:0]');
            expect(exactDisplayType(port(ddrCtrl, 'ready'), 'ddr_ctrl.ready')).toBe('logic');
            expect(exactDisplayType(signal(ddrCtrl, 'addr_q'), 'ddr_ctrl.addr_q')).toBe('logic [11:0]');
            expect(exactDisplayType(signal(ddrCtrl, 'busy_q'), 'ddr_ctrl.busy_q')).toBe('logic');

            expect(exactDisplayType(parameter(wideDdrCtrl, 'DATA_W'), 'ddr_ctrl_wide.DATA_W')).toBe('int');
            expect(exactDisplayType(parameter(wideDdrCtrl, 'ADDR_W'), 'ddr_ctrl_wide.ADDR_W')).toBe('int');
            expect(exactDisplayType(parameter(wideDdrCtrl, 'LANES'), 'ddr_ctrl_wide.LANES')).toBe('int');
            expect(parameter(wideDdrCtrl, 'DATA_W').value).toEqual(expect.stringContaining('16'));
            expect(parameter(wideDdrCtrl, 'ADDR_W').value).toEqual(expect.stringContaining('10'));
            expect(parameter(wideDdrCtrl, 'LANES').value).toEqual(expect.stringContaining('2'));
            expect(exactDisplayType(port(wideDdrCtrl, 'clk'), 'ddr_ctrl_wide.clk')).toBe('logic');
            expect(exactDisplayType(port(wideDdrCtrl, 'rst_n'), 'ddr_ctrl_wide.rst_n')).toBe('logic');
            expect(exactDisplayType(port(wideDdrCtrl, 'wr_en'), 'ddr_ctrl_wide.wr_en')).toBe('logic [1:0]');
            expect(exactDisplayType(port(wideDdrCtrl, 'wdata'), 'ddr_ctrl_wide.wdata')).toBe('logic [15:0]');
            expect(exactDisplayType(port(wideDdrCtrl, 'rdata'), 'ddr_ctrl_wide.rdata')).toBe('logic [15:0]');
            expect(exactDisplayType(port(wideDdrCtrl, 'ready'), 'ddr_ctrl_wide.ready')).toBe('logic');
            expect(exactDisplayType(signal(wideDdrCtrl, 'addr_q'), 'ddr_ctrl_wide.addr_q')).toBe('logic [9:0]');
            expect(exactDisplayType(signal(wideDdrCtrl, 'busy_q'), 'ddr_ctrl_wide.busy_q')).toBe('logic');
            expect(exactDisplayType(port(wideDdrCtrl, 'rdata'), 'ddr_ctrl_wide.rdata')).not.toBe(
                exactDisplayType(rdata, 'ddr_ctrl.rdata'),
            );

            const testedContents = [
                ...(ddrCtrl.params ?? []),
                ...(ddrCtrl.ports ?? []),
                ...(ddrCtrl.signals ?? []),
            ];
            assertContentDeclarationMetadata(
                ddrDefinition,
                session?.fixture.ddrCtrlUri ?? '',
                testedContents,
            );
            const declarationRanges: Readonly<Record<string, ExplorerRange>> = {
                DATA_W: { startLine: 3, startCharacter: 15, endLine: 3, endCharacter: 21 },
                ADDR_W: { startLine: 4, startCharacter: 15, endLine: 4, endCharacter: 21 },
                LANES: { startLine: 5, startCharacter: 15, endLine: 5, endCharacter: 20 },
                clk: { startLine: 7, startCharacter: 27, endLine: 7, endCharacter: 30 },
                rst_n: { startLine: 8, startCharacter: 27, endLine: 8, endCharacter: 32 },
                wr_en: { startLine: 9, startCharacter: 27, endLine: 9, endCharacter: 32 },
                wdata: { startLine: 10, startCharacter: 27, endLine: 10, endCharacter: 32 },
                rdata: { startLine: 11, startCharacter: 27, endLine: 11, endCharacter: 32 },
                ready: { startLine: 12, startCharacter: 27, endLine: 12, endCharacter: 32 },
                addr_q: { startLine: 15, startCharacter: 20, endLine: 15, endCharacter: 26 },
                busy_q: { startLine: 16, startCharacter: 20, endLine: 16, endCharacter: 26 },
            };
            assertExactDeclarationLocations(
                testedContents,
                session?.fixture.ddrCtrlUri ?? '',
                session?.fixture.ddrCtrlPath ?? '',
                declarationRanges,
                ddrCtrl,
                ddrDefinition,
            );
            assertExactDeclarationLocations(
                [
                    ...(wideDdrCtrl.params ?? []),
                    ...(wideDdrCtrl.ports ?? []),
                    ...(wideDdrCtrl.signals ?? []),
                ],
                session?.fixture.ddrCtrlUri ?? '',
                session?.fixture.ddrCtrlPath ?? '',
                declarationRanges,
                wideDdrCtrl,
                ddrDefinition,
            );
            await assertDocumentDeclarationMetadata(
                session?.client as LspStdioClient,
                session?.fixture.ddrCtrlUri ?? '',
                testedContents,
            );

            const portNames = new Set((ddrCtrl.ports ?? []).map((port) => port.name));
            const signalNames = (ddrCtrl.signals ?? []).map((signal) => signal.name);
            expect(signalNames.some((name) => portNames.has(name))).toBe(false);

            const shapeDeclarationRanges: Readonly<Record<string, ExplorerRange>> = {
                WIDTH: { startLine: 3, startCharacter: 18, endLine: 3, endCharacter: 23 },
                DEPTH: { startLine: 4, startCharacter: 18, endLine: 4, endCharacter: 23 },
                packed_bus: { startLine: 6, startCharacter: 34, endLine: 6, endCharacter: 44 },
                unpacked_bus: { startLine: 8, startCharacter: 8, endLine: 8, endCharacter: 20 },
                named_port: { startLine: 9, startCharacter: 26, endLine: 9, endCharacter: 36 },
                scalar_wire_port: { startLine: 10, startCharacter: 16, endLine: 10, endCharacter: 32 },
                packed_signal: { startLine: 13, startCharacter: 27, endLine: 13, endCharacter: 40 },
                unpacked_signal: { startLine: 15, startCharacter: 8, endLine: 15, endCharacter: 23 },
                named_signal: { startLine: 16, startCharacter: 19, endLine: 16, endCharacter: 31 },
                scalar_wire_signal: { startLine: 17, startCharacter: 9, endLine: 17, endCharacter: 27 },
                start: { startLine: 19, startCharacter: 9, endLine: 19, endCharacter: 14 },
            };

            const assertTypeShapes = (node: ExplorerNode, width: number, depth: number): void => {
                expect(parameter(node, 'WIDTH').value).toEqual(expect.stringContaining(String(width)));
                expect(parameter(node, 'DEPTH').value).toEqual(expect.stringContaining(String(depth)));
                expect(exactDisplayType(parameter(node, 'WIDTH'), `${node.instanceName}.WIDTH`)).toBe('int');
                expect(exactDisplayType(parameter(node, 'DEPTH'), `${node.instanceName}.DEPTH`)).toBe('int');
                expect(exactDisplayType(port(node, 'packed_bus'), `${node.instanceName}.packed_bus`))
                    .toBe(`logic [1:0] [${width - 1}:0]`);
                expect(exactDisplayType(port(node, 'unpacked_bus'), `${node.instanceName}.unpacked_bus`))
                    .toBe(`logic [${width - 1}:0] [0:3]`);
                expect(exactDisplayType(port(node, 'named_port'), `${node.instanceName}.named_port`))
                    .toBe('scalar_alias_t');
                expect(exactDisplayType(port(node, 'scalar_wire_port'), `${node.instanceName}.scalar_wire_port`))
                    .toBe('wire');
                expect(exactDisplayType(signal(node, 'packed_signal'), `${node.instanceName}.packed_signal`))
                    .toBe(`logic [1:0] [${width - 1}:0]`);
                expect(exactDisplayType(signal(node, 'unpacked_signal'), `${node.instanceName}.unpacked_signal`))
                    .toBe(`logic [${width - 1}:0] [0:3]`);
                expect(exactDisplayType(signal(node, 'named_signal'), `${node.instanceName}.named_signal`))
                    .toBe('scalar_alias_t');
                const scalarWireSignal = signal(node, 'scalar_wire_signal');
                expect(scalarWireSignal.kind).toBe('wire');
                expect(exactDisplayType(scalarWireSignal, `${node.instanceName}.scalar_wire_signal`)).toBe('wire');
                const start = signal(node, 'start');
                expect(start.kind).toBe('wire');
                expect(exactDisplayType(start, `${node.instanceName}.start`)).toBe('wire');
                expect(start.type?.displayType ?? '').not.toContain('//');
                expect(start.type?.displayType ?? '').not.toContain('This is a line comment');
            };

            assertTypeShapes(typeShapesDefault, 8, 4);
            assertTypeShapes(typeShapesWide, 16, 2);
            expect(exactDisplayType(port(typeShapesDefault, 'packed_bus'), 'type_shapes_default.packed_bus'))
                .not.toBe(exactDisplayType(port(typeShapesWide, 'packed_bus'), 'type_shapes_wide.packed_bus'));
            expect(exactDisplayType(port(typeShapesDefault, 'unpacked_bus'), 'type_shapes_default.unpacked_bus'))
                .not.toBe(exactDisplayType(port(typeShapesWide, 'unpacked_bus'), 'type_shapes_wide.unpacked_bus'));

            const typeShapesContents = [
                ...(typeShapesDefault.params ?? []),
                ...(typeShapesDefault.ports ?? []),
                ...(typeShapesDefault.signals ?? []),
            ];
            assertContentDeclarationMetadata(
                typeShapesDefinition,
                session?.fixture.typeShapesUri ?? '',
                typeShapesContents,
            );
            assertExactDeclarationLocations(
                typeShapesContents,
                session?.fixture.typeShapesUri ?? '',
                session?.fixture.typeShapesPath ?? '',
                shapeDeclarationRanges,
                typeShapesDefault,
                typeShapesDefinition,
            );
            assertExactDeclarationLocations(
                [
                    ...(typeShapesWide.params ?? []),
                    ...(typeShapesWide.ports ?? []),
                    ...(typeShapesWide.signals ?? []),
                ],
                session?.fixture.typeShapesUri ?? '',
                session?.fixture.typeShapesPath ?? '',
                shapeDeclarationRanges,
                typeShapesWide,
                typeShapesDefinition,
            );
            await assertDocumentDeclarationMetadata(
                session?.client as LspStdioClient,
                session?.fixture.typeShapesUri ?? '',
                typeShapesContents,
            );

        });

        afterAll(async () => {
            await stopSession(session);
        }, 30_000);
    });

    describe('with the foo.v comment-leak reproduction', () => {
        let session: ExplorerSession | undefined;

        beforeAll(async () => {
            session = await startSession(undefined, true);
        }, 180_000);

        it('does not include a preceding line comment in a plain wire type display', () => {
            const fixture = session?.fixture;
            expect(fixture).toBeDefined();
            if (!fixture) {
                throw new Error('foo.v fixture was not created');
            }
            const foo = findNode(session?.snapshot.roots ?? [], (node) => nodeName(node) === 'Foo');
            const start = signal(foo, 'start');
            expect(foo.contentSource).toBe('elaborated');
            expect(start.kind).toBe('wire');
            expect(exactDisplayType(start, 'Foo.start')).toBe('wire');
            expect(start.type?.displayType).toBe('wire');
            expect(start.location).toEqual({
                uri: fixture.fooUri,
                range: { startLine: 3, startCharacter: 5, endLine: 3, endCharacter: 10 },
            });
        });

        afterAll(async () => {
            await stopSession(session);
        }, 30_000);
    });

    describe('with compile.top configured', () => {
        let session: ExplorerSession | undefined;

        beforeAll(async () => {
            session = await startSession('top');
        }, 180_000);

        it('keeps an instantiated configured top nested instead of promoting it to a root', () => {
            const roots = session?.snapshot.roots ?? [];
            const rootNames = roots.map(nodeName).sort();
            expect(rootNames).toEqual(['deep_mod', 'tb_top', 'type_shapes_decl_only']);
            expect(rootNames).not.toContain('top');
            expect(rootNames).not.toContain('ddr_ctrl');
        });

        it('keeps the configured top nested under tb_top with elaborated contents and declaration-only fallback', async () => {
            const roots = session?.snapshot.roots ?? [];
            const tbTop = findNode(roots, (node) => nodeName(node) === 'tb_top');
            const declarationOnly = findNode(
                roots,
                (node) => nodeName(node) === 'type_shapes_decl_only',
            );
            const nestedTop = findNode(tbTop.children, (node) => node.moduleType === 'top');
            const nestedDdrCtrl = findNode(nestedTop.children, (node) => node.moduleType === 'ddr_ctrl');
            const snapshot = session?.snapshot as ExplorerSnapshot;
            const ddrDefinition = moduleDefinition(snapshot, nestedDdrCtrl);
            const declarationOnlyDefinition = moduleDefinition(snapshot, declarationOnly);

            const topOccurrences = collectNodes(roots).filter((node) => node.moduleType === 'top');
            expect(topOccurrences).toHaveLength(1);
            expect(topOccurrences[0]).toBe(nestedTop);
            expect(nestedTop.moduleType).toBe('top');
            expect(nestedTop.id).toMatch(/^instance:/);
            expect(nestedTop.id).toContain('tb_top.u_top');
            expect(declarationOnly.contentSource).toBe('declaration');
            expect(declarationOnlyDefinition.contentSource).toBe('declaration');
            expect(nestedTop.instanceName).toBe('u_top');
            expect(nestedDdrCtrl.instanceName).toBe('u_ddr_ctrl');
            expect(nestedDdrCtrl.contentSource).toBe('elaborated');
            expect(nestedDdrCtrl.uri).toBe(session?.fixture.topUri);
            sourceRange(nestedDdrCtrl.range, 'declaration-backed instance site');
            // The configured `top` is already instantiated under tb_top, so it
            // must not also be rendered as an ordinary root. The nested
            // occurrence is recovered from the committed source graph.
            // The configured top's retained elaborated instance is associated
            // with this source occurrence, so its instance-specific values and
            // concrete parameter-dependent dimensions must be preserved.
            expect(nestedDdrCtrl.params?.some((param) => param.name === 'DATA_W')).toBe(true);
            expect(parameter(nestedDdrCtrl, 'DATA_W').value).toEqual(expect.stringContaining('8'));
            const fallbackRdata = nestedDdrCtrl.ports?.find((port) => port.name === 'rdata');
            if (!fallbackRdata) {
                throw new Error('configured top elaborated instance is missing rdata');
            }
            expect(fallbackRdata.detail ?? '').not.toContain('DATA_W-1:0');
            expect(exactDisplayType(fallbackRdata, 'top.u_ddr_ctrl.rdata')).toBe('logic [7:0]');
            const testedContents = [
                ...(nestedDdrCtrl.params ?? []),
                ...(nestedDdrCtrl.ports ?? []),
                ...(nestedDdrCtrl.signals ?? []),
            ];
            assertContentDeclarationMetadata(
                ddrDefinition,
                session?.fixture.ddrCtrlUri ?? '',
                testedContents,
            );
            await assertDocumentDeclarationMetadata(
                session?.client as LspStdioClient,
                session?.fixture.ddrCtrlUri ?? '',
                testedContents,
            );

            // This root is intentionally absent from the configured
            // elaboration. Its Module Contents must therefore come from the
            // source declaration, preserving scalar named types and net
            // qualifiers without accidentally exercising elaborated data.
            expect(declarationOnly.ports?.map((entry) => entry.name)).toEqual(expect.arrayContaining([
                'named_port', 'scalar_wire_port',
            ]));
            expect(declarationOnly.signals?.map((entry) => entry.name)).toEqual(expect.arrayContaining([
                'named_signal', 'scalar_wire_signal',
            ]));
            expect(exactDisplayType(port(declarationOnly, 'named_port'), 'type_shapes_decl_only.named_port'))
                .toBe('scalar_alias_t');
            expect(exactDisplayType(port(declarationOnly, 'scalar_wire_port'), 'type_shapes_decl_only.scalar_wire_port'))
                .toBe('wire');
            expect(exactDisplayType(signal(declarationOnly, 'named_signal'), 'type_shapes_decl_only.named_signal'))
                .toBe('scalar_alias_t');
            const declarationOnlyScalarWire = signal(declarationOnly, 'scalar_wire_signal');
            expect(declarationOnlyScalarWire.kind).toBe('wire');
            expect(exactDisplayType(declarationOnlyScalarWire, 'type_shapes_decl_only.scalar_wire_signal'))
                .toBe('wire');
            const declarationOnlyContents = [
                port(declarationOnly, 'named_port'),
                port(declarationOnly, 'scalar_wire_port'),
                signal(declarationOnly, 'named_signal'),
                declarationOnlyScalarWire,
            ];
            assertContentDeclarationMetadata(
                declarationOnlyDefinition,
                session?.fixture.typeShapesUri ?? '',
                declarationOnlyContents,
            );
            const declarationOnlyRanges: Readonly<Record<string, ExplorerRange>> = {
                named_port: { startLine: 25, startCharacter: 26, endLine: 25, endCharacter: 36 },
                scalar_wire_port: { startLine: 26, startCharacter: 16, endLine: 26, endCharacter: 32 },
                named_signal: { startLine: 28, startCharacter: 19, endLine: 28, endCharacter: 31 },
                scalar_wire_signal: { startLine: 29, startCharacter: 9, endLine: 29, endCharacter: 27 },
            };
            assertExactDeclarationLocations(
                declarationOnlyContents,
                session?.fixture.typeShapesUri ?? '',
                session?.fixture.typeShapesPath ?? '',
                declarationOnlyRanges,
                declarationOnly,
                declarationOnlyDefinition,
            );
            await assertDocumentDeclarationMetadata(
                session?.client as LspStdioClient,
                session?.fixture.typeShapesUri ?? '',
                declarationOnlyContents,
            );
        });

        afterAll(async () => {
            await stopSession(session);
        }, 30_000);
    });
});
