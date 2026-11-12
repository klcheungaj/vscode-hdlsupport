import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
    BLK_SV_TEXT,
    createShadowingFixture,
    EDIT_BUFFER_SV_TEXT,
    FUNC_SV_TEXT,
    GEN_SV_TEXT,
    TASK_SV_TEXT,
    TB_CROSS_SV_TEXT,
    TB_NESTED_SV_TEXT,
    TWO_SV_TEXT,
    type ShadowingFixture,
} from './fixtures/shadowingWorkspace';
import { LspStdioClient } from './helpers/lspClient';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_BIN = path.join(REPO_ROOT, 'server', 'linux-x64', 'llg_ls');

const READY_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 300;
const READY_MESSAGE_FRAGMENT = 'language server ready';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

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
    console.info(`[skip] shadowing e2e: staged binary missing or not executable at ${SERVER_BIN}`);
}
const describeIfBinary = binaryAvailable ? describe : describe.skip;

interface LocationShape {
    uri?: string;
    range?: { start?: { line?: number; character?: number } };
}

function asRecord(value: unknown): Record<string, unknown> {
    return (value !== null && typeof value === 'object' ? value : {}) as Record<string, unknown>;
}

function positionOf(
    text: string,
    needle: string,
    offset: number,
): { line: number; character: number } {
    const index = text.indexOf(needle);
    if (index < 0) {
        throw new Error(`needle ${JSON.stringify(needle)} not found in source`);
    }
    const upto = index + offset;
    const before = text.slice(0, upto);
    const line = before.split('\n').length - 1;
    const lineStart = before.lastIndexOf('\n') + 1;
    return { line, character: upto - lineStart };
}

/** Start position of the single Location the server must answer with. */
function singleStart(result: unknown, what: string): { uri: string; start: Record<string, unknown> } {
    const record = asRecord(result);
    if (typeof record.uri !== 'string') {
        throw new Error(`${what} must be a single Location object: ${JSON.stringify(result)}`);
    }
    const start = asRecord(asRecord(record.range).start);
    if (typeof start.line !== 'number' || typeof start.character !== 'number') {
        throw new Error(`${what} must carry a range.start: ${JSON.stringify(result)}`);
    }
    return { uri: record.uri, start };
}

/** Defensive Location match: early polls can legitimately answer null. */
function matchesLocation(
    candidate: unknown,
    wantUri: string,
    want: { line: number; character: number },
): boolean {
    const record = candidate !== null && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : null;
    if (record === null || typeof record.uri !== 'string') {
        return false;
    }
    const start = asRecord(asRecord(record.range).start);
    return record.uri === wantUri
        && start.line === want.line
        && start.character === want.character;
}

/** Hover markup text (`contents.value`) or an empty string when null. */
async function hoverMarkup(
    client: LspStdioClient,
    uri: string,
    position: { line: number; character: number },
): Promise<string> {
    const hover = await client.request<{ contents?: { value?: string } }>(
        'textDocument/hover',
        { textDocument: { uri }, position },
        REQUEST_TIMEOUT_MS,
    );
    return asRecord(hover?.contents).value as string ?? '';
}

/** Poll definition until `predicate` accepts it; fails with the last answer. */
async function pollDefinition(
    client: LspStdioClient,
    uri: string,
    position: { line: number; character: number },
    predicate: (result: unknown) => boolean,
    what: string,
): Promise<unknown> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let last: unknown = undefined;
    for (;;) {
        last = await client.request(
            'textDocument/definition',
            { textDocument: { uri }, position },
            REQUEST_TIMEOUT_MS,
        );
        if (predicate(last)) {
            return last;
        }
        if (Date.now() > deadline) {
            throw new Error(
                `${what}: definition never reached the expected target; last=${JSON.stringify(last)}`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

describeIfBinary('llg variable-shadowing navigation end-to-end (staged binary)', () => {
    let client!: LspStdioClient;
    let fixture!: ShadowingFixture;
    let documentVersion = 1;

    const expectDefinitionAt = async (
        text: string,
        uri: string,
        needle: string,
        offset: number,
        wantUri: string,
        wantStart: { line: number; character: number },
        what: string,
    ): Promise<void> => {
        const position = positionOf(text, needle, offset);
        const result = await pollDefinition(
            client,
            uri,
            position,
            (candidate) => matchesLocation(candidate, wantUri, wantStart),
            what,
        );
        const resolved = singleStart(result, what);
        expect(resolved.uri).toBe(wantUri);
        expect(resolved.start).toEqual(wantStart);
    };

    beforeAll(async () => {
        fixture = createShadowingFixture();
        client = LspStdioClient.spawn(SERVER_BIN, [], { cwd: fixture.baseDir });

        await client.request<Record<string, unknown>>(
            'initialize',
            {
                processId: process.pid,
                rootUri: null,
                workspaceFolders: [{ uri: `file://${fixture.projectDir}`, name: 'ws' }],
                clientInfo: { name: 'hdlsupport-shadowing-e2e', version: '0.0.1' },
                capabilities: {
                    workspace: {
                        configuration: true,
                        workspaceFolders: true,
                    },
                },
                initializationOptions: {
                    llg: {
                        protocolVersion: 1,
                        configFiles: [
                            {
                                workspaceUri: `file://${fixture.projectDir}`,
                                path: fixture.configPath,
                            },
                        ],
                    },
                },
            },
            REQUEST_TIMEOUT_MS,
        );
        client.notify('initialized', {});

        // The ready log message is the contract for "initial scan committed".
        await client.waitForNotification(
            'window/logMessage',
            (params) => {
                const message = asRecord(params).message;
                return typeof message === 'string' && message.includes(READY_MESSAGE_FRAGMENT);
            },
            READY_TIMEOUT_MS,
            0,
        );
    }, 180_000);

    afterAll(async () => {
        if (binaryAvailable && typeof client !== 'undefined' && client !== undefined && !client.exited) {
            await client.stop(15_000).catch(async () => client.kill());
        }
        if (typeof fixture !== 'undefined' && fixture !== undefined) {
            fixture.dispose();
        }
    }, 30_000);

    it('resolves named begin/end block shadowing in both directions', async () => {
        const text = BLK_SV_TEXT;
        const { blkUri } = fixture;

        // Use INSIDE the block → the block-local declaration.
        await expectDefinitionAt(text, blkUri, 'val = en', 1, blkUri, { line: 5, character: 16 }, 'inner use');
        // Use OUTSIDE the block → the module-level declaration.
        await expectDefinitionAt(text, blkUri, "assign val = 8", 7, blkUri, { line: 1, character: 14 }, 'outer use');
        // The OUTER declaration resolves to itself.
        await expectDefinitionAt(text, blkUri, '[7:0] val', 6, blkUri, { line: 1, character: 14 }, 'outer decl self');
    });

    it('keeps function call-site arguments on the module-level signal', async () => {
        const text = FUNC_SV_TEXT;
        // Call-site arg `dat[1:0]` inside f_sh(...) → the module-level `dat`.
        await expectDefinitionAt(text, fixture.funcUri, 'f_sh(dat', 5, fixture.funcUri, { line: 1, character: 14 }, 'call-site arg');
        // Uses outside the function body stay on the module-level signal too.
        await expectDefinitionAt(text, fixture.funcUri, 'assign out', 7, fixture.funcUri, { line: 2, character: 14 }, 'assign lhs use');
    });

    it('keeps task-external uses on the module-level signal', async () => {
        const text = TASK_SV_TEXT;
        // Module-level use AFTER the task call → the module-level `cap`.
        await expectDefinitionAt(text, fixture.taskUri, "cap = 8'h00", 1, fixture.taskUri, { line: 1, character: 14 }, 'post-task use');
        // Unshadowed call-site argument still hits its own declaration.
        await expectDefinitionAt(text, fixture.taskUri, 't_sh(go', 6, fixture.taskUri, { line: 2, character: 8 }, 'call-site go');
    });

    it('binds generate-block-external uses to the outer declaration', async () => {
        const text = GEN_SV_TEXT;
        // BEFORE the generate → the outer `[7:0] val`.
        await expectDefinitionAt(text, fixture.genUri, 'pre = val', 7, fixture.genUri, { line: 1, character: 14 }, 'use before generate');
        // AFTER the generate → the same outer declaration.
        await expectDefinitionAt(text, fixture.genUri, 'post = val', 7, fixture.genUri, { line: 1, character: 14 }, 'use after generate');
    });

    it('wins two-level nesting at each level for goto-definition', async () => {
        const text = TWO_SV_TEXT;
        // Inside inner_blk → innermost declaration.
        await expectDefinitionAt(text, fixture.twoUri, "sig = {3'b000", 1, fixture.twoUri, { line: 7, character: 18 }, 'innermost scope');
        // In outer_blk but outside inner_blk → the middle declaration.
        await expectDefinitionAt(text, fixture.twoUri, 'sig = en ?', 1, fixture.twoUri, { line: 5, character: 16 }, 'middle scope');
        // Module level → the module-level net.
        await expectDefinitionAt(text, fixture.twoUri, 'assign sig = 16', 7, fixture.twoUri, { line: 1, character: 15 }, 'module level');
    });

    it('keeps nested instance namespaces within their own module', async () => {
        // Child-internal use → the child's OWN port (per-instance clone).
        const leafText = fs.readFileSync(fixture.leafPath, 'utf8');
        await expectDefinitionAt(leafText, fixture.leafUri, '= mode;', 3, fixture.leafUri, { line: 0, character: 24 }, 'child-internal use');

        const tbText = TB_NESTED_SV_TEXT;
        // Label `.mode` → child port (cross-file); actual `(mode)` → tb's own.
        await expectDefinitionAt(tbText, fixture.tbNestedUri, '.mode(mode)', 2, fixture.leafUri, { line: 0, character: 24 }, 'connection label');
        await expectDefinitionAt(tbText, fixture.tbNestedUri, '.mode(mode)', 7, fixture.tbNestedUri, { line: 1, character: 8 }, 'connection actual');
        // tb's block-local shadow and module-level use stay in the tb file.
        await expectDefinitionAt(tbText, fixture.tbNestedUri, "mode = 1'b0", 1, fixture.tbNestedUri, { line: 7, character: 16 }, 'tb block-local use');
        await expectDefinitionAt(tbText, fixture.tbNestedUri, "assign mode = 1'b1;", 8, fixture.tbNestedUri, { line: 1, character: 8 }, 'tb module-level use');
    });

    it('keeps cross-file shadowing within the instantiating module', async () => {
        const text = TB_CROSS_SV_TEXT;
        // Label `.sel` → the CHILD module's port in cross_leaf.sv.
        await expectDefinitionAt(text, fixture.tbCrossUri, '.sel(sel)', 2, fixture.crossLeafUri, { line: 0, character: 30 }, 'cross-file label');
        // Connected ACTUAL → tb's OWN module-level declaration.
        await expectDefinitionAt(text, fixture.tbCrossUri, '.sel(sel)', 7, fixture.tbCrossUri, { line: 1, character: 8 }, 'cross-file actual');
        // Block-local use → the block-local declaration in the SAME file.
        await expectDefinitionAt(text, fixture.tbCrossUri, "sel = 1'b0", 1, fixture.tbCrossUri, { line: 7, character: 16 }, 'block-local sel');
        // Module-level use → the tb's own declaration again.
        await expectDefinitionAt(text, fixture.tbCrossUri, "assign sel = 1'b1;", 8, fixture.tbCrossUri, { line: 1, character: 8 }, 'module-level sel');
    });

    it('honors a client-side added inner block in an opened buffer', async () => {
        documentVersion += 1;
        client.notify('textDocument/didOpen', {
            textDocument: {
                uri: fixture.editBaseUri,
                languageId: 'systemverilog',
                version: documentVersion,
                text: fs.readFileSync(fixture.editBasePath, 'utf8'),
            },
        });
        documentVersion += 1;
        client.notify('textDocument/didChange', {
            textDocument: { uri: fixture.editBaseUri, version: documentVersion },
            contentChanges: [{ text: EDIT_BUFFER_SV_TEXT }],
        });
        const text = EDIT_BUFFER_SV_TEXT;
        // Inside the CLIENT-SIDE block → the added local declaration (4:16).
        await expectDefinitionAt(text, fixture.editBaseUri, 'val = en', 1, fixture.editBaseUri, { line: 4, character: 16 }, 'staged inner use');
        // Outside the block → the module-level declaration (1:14).
        await expectDefinitionAt(text, fixture.editBaseUri, "assign val = 8", 7, fixture.editBaseUri, { line: 1, character: 14 }, 'staged outer use');
    });

    // ── Shadowing contract cases that used to be known gaps; the llg
    // shadowing-resolution fix closed them (hover consults elaboration
    // bindings + position-accurate declaration snippets, find-references
    // splits conflated sets per bound target, and function/task/genblk
    // interiors plus declaration sites resolve binding-precisely).

    it('hovers show the shadowing declaration type', async () => {
        const text = BLK_SV_TEXT;
        const markup = await hoverMarkup(client, fixture.blkUri, positionOf(text, 'val = en', 2));
        expect(markup).toContain('[3:0]');
        const outerMarkup = await hoverMarkup(client, fixture.blkUri, positionOf(text, 'assign val = 8', 8));
        expect(outerMarkup).toContain('[7:0]');
    });

    it('find-references respect shadow scopes', async () => {
        const text = TWO_SV_TEXT;
        const innerRefs = await client.request<unknown[]>(
            'textDocument/references',
            {
                textDocument: { uri: fixture.twoUri },
                position: positionOf(text, '[3:0] sig', 6),
                context: { includeDeclaration: true },
            },
            REQUEST_TIMEOUT_MS,
        );
        const starts = (Array.isArray(innerRefs) ? innerRefs : [])
            .map((location) => asRecord(asRecord(location).range).start)
            // Stringify [line, character] pairs (not the raw object) so the
            // comparison is independent of the server's JSON key order.
            .map((start) => {
                const record = asRecord(start);
                return JSON.stringify([record.line, record.character]);
            })
            .sort();
        expect(starts).toEqual([
            JSON.stringify([7, 18]),
            JSON.stringify([8, 6]),
        ]);
    });

    it('function/task/genblk interior refs resolve to their local declaration', async () => {
        // Function body.
        await expectDefinitionAt(FUNC_SV_TEXT, fixture.funcUri, "dat = {2'b00", 1, fixture.funcUri, { line: 5, character: 16 }, 'function-body write');
        await expectDefinitionAt(FUNC_SV_TEXT, fixture.funcUri, 'return dat', 8, fixture.funcUri, { line: 5, character: 16 }, 'function-body read');
        // Task body.
        await expectDefinitionAt(TASK_SV_TEXT, fixture.taskUri, "cap = {12'h0", 1, fixture.taskUri, { line: 5, character: 17 }, 'task-body write');
        // Generate block interior.
        await expectDefinitionAt(GEN_SV_TEXT, fixture.genUri, "assign val = 4'h0", 7, fixture.genUri, { line: 10, character: 18 }, 'genblk-interior use');
        // A request ON the block-local declaration resolves to itself.
        await expectDefinitionAt(BLK_SV_TEXT, fixture.blkUri, '[3:0] val', 6, fixture.blkUri, { line: 5, character: 16 }, 'inner decl self');
    });
});

// Always-on guard for the shadowing contract cases above (formerly skipped
// "[known gap]" cases): this pins their hand-written position math to the
// fixture constants - every request needle must resolve where the case
// assumes, and every claimed definition/reference coordinate must sit on the
// intended identifier fragment. Pure text checks; no server or network.
describe('shadowing-case position sanity (always on)', () => {
    /** The claimed position must sit on `fragment` inside the fixture text. */
    const expectPositionOn = (
        text: string,
        want: { line: number; character: number },
        fragment: string,
    ): void => {
        const row = text.split('\n')[want.line];
        expect(row).toBeDefined();
        expect(row.slice(want.character, want.character + fragment.length)).toBe(fragment);
    };

    it('anchors every skipped-case needle and claimed coordinate in its fixture', () => {
        // Hover gap: requests land on the block-local use and the module-level
        // use; the quoted width ranges live on their declaration rows.
        expect(positionOf(BLK_SV_TEXT, 'val = en', 2)).toEqual({ line: 6, character: 6 });
        expect(positionOf(BLK_SV_TEXT, 'assign val = 8', 8)).toEqual({ line: 9, character: 10 });
        expectPositionOn(BLK_SV_TEXT, { line: 5, character: 10 }, '[3:0]');
        expectPositionOn(BLK_SV_TEXT, { line: 1, character: 8 }, '[7:0]');

        // References gap: the query sits on the innermost `[3:0] sig`
        // declaration, and both claimed reference rows really carry `sig`.
        expect(positionOf(TWO_SV_TEXT, '[3:0] sig', 6)).toEqual({ line: 7, character: 18 });
        expectPositionOn(TWO_SV_TEXT, { line: 7, character: 18 }, 'sig');
        expectPositionOn(TWO_SV_TEXT, { line: 8, character: 6 }, 'sig');

        // Interior-definition gap: each request needle lands on its use site
        // and each claimed target sits on the shadowing local declaration.
        expect(positionOf(FUNC_SV_TEXT, "dat = {2'b00", 1)).toEqual({ line: 6, character: 5 });
        expect(positionOf(FUNC_SV_TEXT, 'return dat', 8)).toEqual({ line: 7, character: 12 });
        expectPositionOn(FUNC_SV_TEXT, { line: 5, character: 16 }, 'dat');
        expect(positionOf(TASK_SV_TEXT, "cap = {12'h0", 1)).toEqual({ line: 6, character: 5 });
        expectPositionOn(TASK_SV_TEXT, { line: 5, character: 17 }, 'cap');
        expect(positionOf(GEN_SV_TEXT, "assign val = 4'h0", 7)).toEqual({ line: 11, character: 13 });
        expectPositionOn(GEN_SV_TEXT, { line: 10, character: 18 }, 'val');
        // Request ON the block-local declaration resolves to itself.
        expect(positionOf(BLK_SV_TEXT, '[3:0] val', 6)).toEqual({ line: 5, character: 16 });
        expectPositionOn(BLK_SV_TEXT, { line: 5, character: 16 }, 'val');
    });
});
