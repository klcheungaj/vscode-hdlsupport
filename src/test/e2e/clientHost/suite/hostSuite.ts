// SPDX-License-Identifier: MIT

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { isProcessAlive, terminateRecordedProcesses } from '../../../support/process';

interface MochaHookApi {
    before(hook: () => void | Promise<void>): void;
    after(hook: () => void | Promise<void>): void;
}

// Keep the Mocha hook lookup runtime-only. The host suite is compiled by tsc
// and loaded by Mocha inside the extension host; the repository's unit and
// raw-stdio suites are run separately by Vitest.
const mochaHooks = require('mocha') as MochaHookApi;

// Runtime globals (describe/it/beforeAll/...) are provided by Mocha's BDD UI
// when suite/index.js loads this file inside the electron extension host.

const EXTENSION_ID = 'klcheungaj.hdl-support';
const CONTROL_DIR = process.env.LLG_FAKE_CONTROL_DIR ?? '';
const RECORD_PATH = process.env.LLG_FAKE_RECORD ?? '';
const MODULES_GOTO_COMMAND = 'hdlsupport.modules.gotoDefinition';

interface ExplorerTreeItem {
    readonly id?: string;
    readonly label: string;
    readonly description?: string;
    readonly tooltip?: string;
    readonly collapsibleState: number;
    readonly command?: vscode.Command;
    readonly children: readonly ExplorerTreeItem[];
}

interface SourceRange {
    readonly startLine: number;
    readonly startCharacter: number;
    readonly endLine: number;
    readonly endCharacter: number;
}

interface SourceLocation {
    readonly uri: string;
    readonly range: SourceRange;
}

interface ExplorerTestAdapter {
    wait(): Promise<void>;
    inspect(): {
        hierarchy: ExplorerTreeItem[];
        contents: ExplorerTreeItem[];
        selectedId?: string;
    };
    select(id: string): Promise<void>;
}

interface HdlSupportTestApi {
    moduleExplorer: ExplorerTestAdapter;
    includeLinks: { provider: vscode.DocumentLinkProvider };
}

function controlPath(name: string): string {
    return path.join(CONTROL_DIR, name);
}

function launchCount(): number {
    try {
        return fs.readFileSync(controlPath('launches.log'), 'utf8').split('\n').filter((l) => l.trim() !== '').length;
    } catch {
        return 0;
    }
}

function recordedPid(): number | null {
    try {
        const pid = Number.parseInt(fs.readFileSync(controlPath('server.pid'), 'utf8').trim(), 10);
        return Number.isFinite(pid) ? pid : null;
    } catch {
        return null;
    }
}

async function pollUntil<T>(probe: () => T | null | Promise<T | null>, timeoutMs: number, stepMs = 100): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value !== null) {
            return value;
        }
        if (Date.now() >= deadline) {
            throw new Error(`condition not met within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
}

function workspaceFolder(): vscode.WorkspaceFolder {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'fixture workspace folder is not open');
    return folder;
}

function explorerAdapterOf(extension: vscode.Extension<unknown>): ExplorerTestAdapter {
    const exported = extension.exports as Partial<HdlSupportTestApi> | undefined;
    assert.ok(exported && typeof exported === 'object' && exported.moduleExplorer &&
        typeof exported.moduleExplorer === 'object',
        'HDLSUPPORT_E2E_EXPLORER=1 must return { moduleExplorer } from activate()');
    const adapter = exported.moduleExplorer as Partial<ExplorerTestAdapter>;
    for (const method of [
        'wait',
        'inspect',
        'select',
    ] as const) {
        assert.strictEqual(typeof adapter[method], 'function',
            `explorer test adapter is missing ${method}()`);
    }
    return adapter as ExplorerTestAdapter;
}

function findTreeItem(items: readonly ExplorerTreeItem[], predicate: (item: ExplorerTreeItem) => boolean): ExplorerTreeItem {
    const item = items.find(predicate);
    assert.ok(item, 'expected tree item was not found');
    return item;
}

function contentGroup(items: readonly ExplorerTreeItem[], label: string): ExplorerTreeItem {
    return findTreeItem(items, (item) => item.label === label);
}

function providerContentsLeaf(
    inspection: ReturnType<ExplorerTestAdapter['inspect']>,
    groupLabel: string,
    entryLabel: string,
): vscode.TreeItem {
    const group = contentGroup(inspection.contents, groupLabel);
    const entry = findTreeItem(group.children, (item) => item.label === entryLabel);
    assert.ok(entry.command, `provider did not expose a command for ${groupLabel}/${entryLabel}`);
    return entry as vscode.TreeItem;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function recordedExplorerSnapshot(): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(controlPath('module-explorer.json'), 'utf8')) as unknown;
        const snapshot = asRecord(parsed);
        return Array.isArray(snapshot.roots) && Array.isArray(snapshot.modules) ? snapshot : null;
    } catch {
        return null;
    }
}

function findSnapshotNode(snapshot: Record<string, unknown>, id: string): Record<string, unknown> {
    const visit = (value: unknown): Record<string, unknown> | undefined => {
        const node = asRecord(value);
        if (node.id === id) {
            return node;
        }
        for (const child of asArray(node.children)) {
            const found = visit(child);
            if (found) {
                return found;
            }
        }
        return undefined;
    };
    for (const root of asArray(snapshot.roots)) {
        const found = visit(root);
        if (found) {
            return found;
        }
    }
    throw new Error(`fake module-explorer payload did not contain node ${id}`);
}

function sourceLocation(value: unknown, context: string): SourceLocation {
    const record = asRecord(value);
    assert.strictEqual(typeof record.uri, 'string', `${context} is missing uri`);
    const rawRange = asRecord(record.range);
    const range = {
        startLine: rawRange.startLine,
        startCharacter: rawRange.startCharacter,
        endLine: rawRange.endLine,
        endCharacter: rawRange.endCharacter,
    } as SourceRange;
    for (const [name, coordinate] of [
        ['startLine', range.startLine],
        ['startCharacter', range.startCharacter],
        ['endLine', range.endLine],
        ['endCharacter', range.endCharacter],
    ] as const) {
        assert.strictEqual(typeof coordinate, 'number', `${context} is missing range.${name}`);
        assert.ok(Number.isInteger(coordinate) && coordinate >= 0, `${context} has invalid range.${name}`);
    }
    assert.ok(range.endLine >= range.startLine, `${context} range ends before it starts`);
    if (range.endLine === range.startLine) {
        assert.ok(range.endCharacter >= range.startCharacter, `${context} range has reversed columns`);
    }
    // The fake server runs on the test runner's Node, whose file URLs can encode
    // characters (`~`, the Windows drive colon) differently from the host's
    // Uri.toString(); compare locations in VS Code's form.
    return { uri: vscode.Uri.parse(record.uri as string).toString(), range };
}

function snapshotContentLocation(
    snapshot: Record<string, unknown>,
    nodeId: string,
    collection: 'ports' | 'signals' | 'params',
    name: string,
): SourceLocation {
    const node = findSnapshotNode(snapshot, nodeId);
    const child = asArray(node[collection]).find((candidate) => asRecord(candidate).name === name);
    assert.ok(child, `fake ${collection} payload is missing ${nodeId}.${name}`);
    return sourceLocation(asRecord(child).location, `${nodeId}.${collection}.${name}`);
}

function snapshotNodeLocation(snapshot: Record<string, unknown>, nodeId: string): SourceLocation {
    return sourceLocation(findSnapshotNode(snapshot, nodeId), `fake hierarchy node ${nodeId}`);
}

function snapshotModuleLocation(snapshot: Record<string, unknown>, moduleName: string): SourceLocation {
    const module = asArray(snapshot.modules).find((candidate) => asRecord(candidate).name === moduleName);
    assert.ok(module, `fake module payload is missing ${moduleName}`);
    return sourceLocation(module, `fake module ${moduleName}`);
}

/**
 * Shows `document` in an editor that receives editor commands. Commands such
 * as `editor.action.commentLine` and `default:type` target the focused code
 * editor first, and recent VS Code builds open the Chat view in the secondary
 * side bar, whose input box is a code editor that can keep that focus.
 */
async function showEditorForCommands(document: vscode.TextDocument): Promise<vscode.TextEditor> {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    return vscode.window.showTextDocument(document);
}

function assertActiveEditorAt(location: SourceLocation): void {
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor, 'provider navigation did not leave an active text editor');
    assert.strictEqual(editor.document.uri.toString(), location.uri);
    assert.deepStrictEqual(
        {
            startLine: editor.selection.start.line,
            startCharacter: editor.selection.start.character,
            endLine: editor.selection.end.line,
            endCharacter: editor.selection.end.character,
        },
        location.range,
    );
}

function assertNormalizedDescriptions(
    groups: readonly ExplorerTreeItem[],
    portGroups: readonly ExplorerTreeItem[],
): void {
    for (const group of groups) {
        for (const item of group.children) {
            const description = item.description ?? '';
            assert.ok(!/\s{2,}/.test(description), `${group.label}/${item.label} repeats whitespace: ${description}`);
        }
    }
    for (const group of portGroups) {
        for (const item of group.children) {
            const description = item.description ?? '';
            assert.ok(
                !/^(input|output|inout)\b/i.test(description),
                `${group.label}/${item.label} repeats its direction in the description: ${description}`,
            );
        }
    }
}

function commandLocation(treeItem: vscode.TreeItem, context: string): SourceLocation {
    const command = treeItem.command;
    assert.ok(command, `${context} TreeItem has no command`);
    assert.strictEqual(command.command, MODULES_GOTO_COMMAND, `${context} has the wrong command`);
    assert.ok(command.arguments && command.arguments.length === 1, `${context} command has the wrong arguments`);
    return sourceLocation(command.arguments[0], `${context} command argument`);
}

async function executeTreeItemCommand(treeItem: vscode.TreeItem, context: string): Promise<SourceLocation> {
    const command = treeItem.command;
    assert.ok(command, `${context} TreeItem has no command`);
    const location = commandLocation(treeItem, context);
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    return location;
}

describe('hdlsupport llg client host', () => {
    let extension: vscode.Extension<unknown>;
    let explorer: ExplorerTestAdapter;

    mochaHooks.before(async () => {
        const candidate = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(candidate, `extension ${EXTENSION_ID} is not available in the development host`);
        extension = candidate;
        fs.writeFileSync(controlPath('mode'), 'normal');
    });

    it('activates the extension when a SystemVerilog document is opened', async () => {
        const folder = workspaceFolder();
        const document = await vscode.workspace.openTextDocument(
            vscode.Uri.file(path.join(folder.uri.fsPath, 'top.sv')),
        );
        await vscode.window.showTextDocument(document);
        await extension.activate();
        assert.strictEqual(extension.isActive, true);
        explorer = explorerAdapterOf(extension);
    });

    it('sends initialization options shaped { llg: { protocolVersion: 1, configFiles: [...] } }', async () => {
        await pollUntil(() => (RECORD_PATH !== '' && fs.existsSync(RECORD_PATH) ? true : null), 20_000);
        const raw = JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8')) as {
            capabilities?: unknown;
            workspaceFolders?: Array<{ uri?: string; name?: string }>;
            initializationOptions?: {
                llg?: {
                    protocolVersion?: number;
                    configFiles?: Array<{ workspaceUri?: string; path?: string }>;
                };
            };
        };

        assert.strictEqual(raw.initializationOptions?.llg?.protocolVersion, 1);

        const folder = workspaceFolder();
        const configFiles = raw.initializationOptions?.llg?.configFiles;
        assert.ok(Array.isArray(configFiles) && configFiles.length >= 1, 'configFiles missing');
        // The payload uses Node's file URL form; VS Code encodes Windows drive letters differently.
        assert.strictEqual(vscode.Uri.parse(String(configFiles[0].workspaceUri)).toString(), folder.uri.toString());
        assert.strictEqual(configFiles[0].path, path.join(folder.uri.fsPath, 'llg.toml'));

        assert.ok(raw.capabilities !== undefined, 'client capabilities missing');
        assert.ok(
            Array.isArray(raw.workspaceFolders) && raw.workspaceFolders.some((f) => f.name === folder.name),
            'workspace folders missing from initialize params',
        );
    });

    it('forwards llg-lint publications into VS Code diagnostics', async () => {
        const topUri = vscode.Uri.file(path.join(workspaceFolder().uri.fsPath, 'top.sv'));
        const diagnostic = await pollUntil(() => {
            return vscode.languages.getDiagnostics(topUri).find((candidate) =>
                candidate.source === 'llg-lint' && candidate.code === 'unused-signal',
            ) ?? null;
        }, 20_000);

        assert.strictEqual(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
        assert.ok(diagnostic.message.includes('unused_sig'));
    });

    it('exposes server-owned hover and definition providers but no rename provider', async () => {
        const folder = workspaceFolder();
        const topUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'top.sv'));
        const childUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'child.sv'));

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            topUri,
            new vscode.Position(0, 8),
        );
        assert.ok(hovers.some((hover) => hover.contents.some((content) =>
            typeof content === 'string'
                ? content.includes('Lapligence fake hover')
                : content.value.includes('Lapligence fake hover'),
        )));

        const definitions = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
            'vscode.executeDefinitionProvider',
            topUri,
            new vscode.Position(6, 2),
        );
        assert.ok(definitions.some((definition) =>
            ('uri' in definition ? definition.uri : definition.targetUri).toString() === childUri.toString(),
        ));

        // The fake server advertises renameProvider, but the client ignores it.
        const rename = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
            'vscode.executeDocumentRenameProvider',
            topUri,
            new vscode.Position(0, 8),
            'renamed_top',
        );
        assert.strictEqual(rename?.get(topUri).length ?? 0, 0);
    });

    it('exposes server-owned references and document/workspace symbols', async () => {
        const folder = workspaceFolder();
        const topUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'top.sv'));
        const childUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'child.sv'));

        const references = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            topUri,
            new vscode.Position(0, 8),
        );
        assert.deepStrictEqual(
            references.map((reference) => reference.uri.toString()).sort(),
            [childUri.toString(), topUri.toString()].sort(),
        );

        const documentSymbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
            'vscode.executeDocumentSymbolProvider',
            topUri,
        );
        const top = documentSymbols.find((symbol) => symbol.name === 'top');
        assert.ok(top && 'children' in top, 'server hierarchy was not converted to DocumentSymbol');
        assert.strictEqual(top.detail, 'module');
        assert.ok(top.children.some((symbol) => symbol.name === 'unused_sig'));

        const workspaceSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            'top',
        );
        const workspaceTop = workspaceSymbols.find((symbol) => symbol.name === 'top');
        assert.ok(workspaceTop, 'workspace symbol result is missing top');
        assert.strictEqual(workspaceTop.location.uri.toString(), topUri.toString());
    });

    it('exposes server-owned completion and semantic tokens', async () => {
        const topUri = vscode.Uri.file(path.join(workspaceFolder().uri.fsPath, 'top.sv'));
        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            topUri,
            new vscode.Position(6, 4),
            '.',
        );
        const childCompletion = completions.items.find((item) => item.label === 'child');
        assert.ok(childCompletion, 'server completion result is missing child');
        assert.strictEqual(childCompletion.kind, vscode.CompletionItemKind.Module);
        assert.strictEqual(childCompletion.detail, 'module child');

        const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
            'vscode.provideDocumentSemanticTokensLegend',
            topUri,
        );
        assert.deepStrictEqual(legend.tokenTypes, ['keyword', 'class', 'variable']);
        assert.deepStrictEqual(legend.tokenModifiers, ['declaration', 'definition', 'readonly', 'connectionLabel']);

        const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
            'vscode.provideDocumentSemanticTokens',
            topUri,
        );
        assert.deepStrictEqual([...tokens.data], [0, 0, 6, 0, 0, 0, 7, 3, 1, 3]);
    });

    it('restarts the language server via hdlsupport.llg.restart', async () => {
        const before = launchCount();
        await assert.doesNotReject(async () => {
            await vscode.commands.executeCommand('hdlsupport.llg.restart');
        });
        await pollUntil(() => (launchCount() > before ? true : null), 20_000);
    });

    it('restarts for launch settings but not for trace-only changes', async () => {
        const configuration = vscode.workspace.getConfiguration('hdlsupport.llg', workspaceFolder().uri);
        const beforeTraceChange = launchCount();
        let logLevelChanged = false;
        try {
            await configuration.update('trace.server', 'messages', vscode.ConfigurationTarget.Workspace);
            await new Promise((resolve) => setTimeout(resolve, 750));
            assert.strictEqual(
                launchCount(),
                beforeTraceChange,
                'trace.server must be applied without restarting the server process',
            );

            await configuration.update('logLevel', 'debug', vscode.ConfigurationTarget.Workspace);
            logLevelChanged = true;
            await pollUntil(() => launchCount() > beforeTraceChange ? true : null, 20_000);
        } finally {
            const beforeRestore = launchCount();
            await configuration.update('trace.server', undefined, vscode.ConfigurationTarget.Workspace);
            await configuration.update('logLevel', undefined, vscode.ConfigurationTarget.Workspace);
            if (logLevelChanged) {
                await pollUntil(() => launchCount() > beforeRestore ? true : null, 20_000);
            }
        }
    });

    it('resumes diagnostics when a broken server path is corrected to the last working value', async () => {
        const configuration = vscode.workspace.getConfiguration('hdlsupport.llg', workspaceFolder().uri);
        const originalPath = configuration.inspect<string>('path')?.workspaceValue;
        const oldPid = await pollUntil(recordedPid, 10_000);
        const before = launchCount();
        try {
            await configuration.update('path', 'hdlsupport-missing-llg-regression-executable', vscode.ConfigurationTarget.Workspace);
            await pollUntil(() => !isProcessAlive(oldPid) ? true : null, 10_000);
            // Await a complete failed attempt: PID exit alone can precede
            // the queued start reading the broken setting.
            await vscode.commands.executeCommand('hdlsupport.llg.restart');
            assert.strictEqual(launchCount(), before, 'the missing executable must not start a server');
            await configuration.update('path', originalPath, vscode.ConfigurationTarget.Workspace);
            await pollUntil(() => launchCount() > before ? true : null, 5_000);
            const newPid = await pollUntil(recordedPid, 10_000);
            assert.notStrictEqual(newPid, oldPid);
            assert.ok(isProcessAlive(newPid));
            const topUri = vscode.Uri.file(path.join(workspaceFolder().uri.fsPath, 'top.sv'));
            await pollUntil(() => vscode.languages.getDiagnostics(topUri).some(diagnostic =>
                diagnostic.source === 'llg-lint' && diagnostic.code === 'unused-signal',
            ) ? true : null, 10_000);
        } finally {
            await configuration.update('path', originalPath, vscode.ConfigurationTarget.Workspace);
            await vscode.commands.executeCommand('hdlsupport.llg.restart');
        }
    });

    it('exhausts bounded restarts while the server keeps crashing after init', async () => {
        // crash:99 exceeds the client's 4-restarts-per-60-seconds policy.
        fs.writeFileSync(controlPath('mode'), 'crash:99');
        const before = launchCount();
        try {
            // The restart command itself completes (stop + one start); the subsequent
            // automatic restarts crash until the tracker is exhausted. We only require
            // the command to resolve without throwing and the crash storm to be visible.
            await assert.doesNotReject(async () => {
                await vscode.commands.executeCommand('hdlsupport.llg.restart');
            });
            await pollUntil(() => (launchCount() >= before + 4 ? true : null), 45_000).catch(() => undefined);
            const observed = launchCount() - before;
            console.info(`[clientHost] observed ${observed} server launches during the crash storm`);
            assert.ok(observed >= 2, `expected repeated server launches, saw ${observed}`);
        } finally {
            fs.writeFileSync(controlPath('mode'), 'normal');
        }
    });

    it('stops the previous server process on restart (deactivation stop path)', async () => {
        // Ensure a healthy server is running first (the crash storm exhausted restarts).
        await assert.doesNotReject(async () => {
            await vscode.commands.executeCommand('hdlsupport.llg.restart');
        });
        const oldPid = await pollUntil(recordedPid, 10_000);
        await pollUntil(() => (isProcessAlive(oldPid) ? true : null), 10_000);

        await assert.doesNotReject(async () => {
            await vscode.commands.executeCommand('hdlsupport.llg.restart');
        });
        const stoppedBy = await pollUntil(() => (!isProcessAlive(oldPid) ? true : null), 15_000);
        assert.strictEqual(stoppedBy, true, `old server pid ${oldPid} survived a restart`);
    });

    it('refreshes and exposes the true nested module hierarchy through the test adapter', async () => {
        await explorer.wait();
        await pollUntil(() => (explorer.inspect().hierarchy.length > 0 ? true : null), 30_000);
        const roots = explorer.inspect().hierarchy;

        const top = findTreeItem(roots, (item) => item.label === 'top');
        const second = findTreeItem(roots, (item) => item.label === 'second');
        assert.ok(top.id && top.id.length > 0);
        assert.ok(second.id && second.id.length > 0);

        const small = findTreeItem(top.children, (item) => item.label === 'u_child_small');
        const wide = findTreeItem(top.children, (item) => item.label === 'u_child_wide');
        const leaf = findTreeItem(small.children, (item) => item.label === 'u_leaf');
        assert.ok(small.id?.includes('u_child_small'));
        assert.ok(wide.id?.includes('u_child_wide'));
        assert.ok(leaf.id?.includes('u_leaf'));
        assert.strictEqual(wide.children.length, 0, 'the selected nested instance must be a hierarchy leaf');

        const fakeSnapshot = await pollUntil(recordedExplorerSnapshot, 20_000);

        // Select the exact returned TreeItem id. The adapter must route this
        // through the hierarchy view's ordinary selection listener, not by
        // setting a private selected-module field in the test.
        assert.ok(wide.id);
        await explorer.select(wide.id);
        let inspection = explorer.inspect();
        assert.strictEqual(inspection.selectedId, wide.id);
        const wideContents = inspection.contents;
        const groupLabels = wideContents.map((item) => item.label);
        assert.deepStrictEqual(groupLabels, ['Parameters', 'Input Ports', 'Output Ports', 'Signals']);

        const parameters = contentGroup(wideContents, 'Parameters');
        const inputPorts = contentGroup(wideContents, 'Input Ports');
        const outputPorts = contentGroup(wideContents, 'Output Ports');
        const signals = contentGroup(wideContents, 'Signals');
        assert.ok(parameters.children.length > 0, 'Parameters group was not expanded');
        assert.ok(inputPorts.children.length > 0, 'Input Ports group was not expanded');
        assert.ok(outputPorts.children.length > 0, 'Output Ports group was not expanded');
        assert.ok(signals.children.length > 0, 'Signals group was not expanded');
        for (const group of [parameters, inputPorts, outputPorts, signals]) {
            assert.strictEqual(group.collapsibleState, 2, `${group.label} group is not expanded`);
        }

        const width = findTreeItem(parameters.children, (item) => item.label === 'WIDTH');
        const clk = findTreeItem(inputPorts.children, (item) => item.label === 'clk');
        const data = findTreeItem(outputPorts.children, (item) => item.label === 'data');
        const lane = findTreeItem(outputPorts.children, (item) => item.label === 'lane');
        const unusedSignal = findTreeItem(signals.children, (item) => item.label === 'unused_sig');
        assert.strictEqual(width.description, 'parameter int = 16');
        assert.strictEqual(clk.description, 'logic');
        assert.strictEqual(data.description, 'logic [15:0]');
        assert.strictEqual(lane.description, 'logic [1:0]');
        assert.strictEqual(unusedSignal.description, 'logic [15:0]');
        assert.ok(!data.description.includes('WIDTH-1:0'));
        assert.ok(!lane.description.includes('[ 1:0]'));
        assertNormalizedDescriptions(
            [parameters, inputPorts, outputPorts, signals],
            [inputPorts, outputPorts],
        );

        const childUri = vscode.Uri.file(path.join(workspaceFolder().uri.fsPath, 'child.sv')).toString();
        const moduleLocation = snapshotModuleLocation(fakeSnapshot, 'child');
        const instanceLocation = snapshotNodeLocation(fakeSnapshot, wide.id);
        const expectedLocations = {
            WIDTH: {
                uri: childUri,
                range: { startLine: 1, startCharacter: 18, endLine: 1, endCharacter: 23 },
            },
            clk: {
                uri: childUri,
                range: { startLine: 3, startCharacter: 30, endLine: 3, endCharacter: 33 },
            },
            data: {
                uri: childUri,
                range: { startLine: 4, startCharacter: 29, endLine: 4, endCharacter: 33 },
            },
            lane: {
                uri: childUri,
                range: { startLine: 5, startCharacter: 29, endLine: 5, endCharacter: 33 },
            },
            unused_sig: {
                uri: childUri,
                range: { startLine: 8, startCharacter: 22, endLine: 8, endCharacter: 32 },
            },
        } as const;

        for (const [collection, name] of [
            ['params', 'WIDTH'],
            ['ports', 'clk'],
            ['ports', 'data'],
            ['ports', 'lane'],
            ['signals', 'unused_sig'],
        ] as const) {
            const location = snapshotContentLocation(fakeSnapshot, wide.id, collection, name);
            assert.deepStrictEqual(location, expectedLocations[name]);
            assert.notDeepStrictEqual(location, moduleLocation,
                `${name} location must not be the child module header`);
            assert.notDeepStrictEqual(location, instanceLocation,
                `${name} location must not be the selected instance site`);
        }

        const wideSnapshotNode = findSnapshotNode(fakeSnapshot, wide.id);
        const wideTypes = {
            WIDTH: asRecord(asRecord(asArray(wideSnapshotNode.params)[0]).type).displayType,
            clk: asRecord(asRecord(asArray(wideSnapshotNode.ports)[0]).type).displayType,
            data: asRecord(asRecord(asArray(wideSnapshotNode.ports)[1]).type).displayType,
            lane: asRecord(asRecord(asArray(wideSnapshotNode.ports)[2]).type).displayType,
            unused_sig: asRecord(asRecord(asArray(wideSnapshotNode.signals)[0]).type).displayType,
        };
        assert.deepStrictEqual(wideTypes, {
            WIDTH: 'int',
            clk: 'logic',
            data: 'logic [15:0]',
            lane: 'logic [1:0]',
            unused_sig: 'logic [15:0]',
        });

        // Resolve the actual Module Contents provider elements and invoke the
        // command attached by ModuleContentsProvider. The inspection adapter
        // is used only to find the stable IDs; no command payload is rebuilt
        // by the test.
        const parameterLeaf = providerContentsLeaf(inspection, 'Parameters', 'WIDTH');
        assert.strictEqual(parameterLeaf.id, width.id);
        const parameterLocation = await executeTreeItemCommand(parameterLeaf, 'WIDTH');
        assert.deepStrictEqual(parameterLocation, expectedLocations.WIDTH);
        assertActiveEditorAt(parameterLocation);

        const portLeaf = providerContentsLeaf(inspection, 'Input Ports', 'clk');
        assert.strictEqual(portLeaf.id, clk.id);
        const portLocation = await executeTreeItemCommand(portLeaf, 'clk');
        assert.deepStrictEqual(portLocation, expectedLocations.clk);
        assertActiveEditorAt(portLocation);

        const signalLeaf = providerContentsLeaf(inspection, 'Signals', 'unused_sig');
        assert.strictEqual(signalLeaf.id, unusedSignal.id);
        const signalLocation = await executeTreeItemCommand(signalLeaf, 'unused_sig');
        assert.deepStrictEqual(signalLocation, expectedLocations.unused_sig);
        assertActiveEditorAt(signalLocation);

        assert.ok(small.id);
        await explorer.select(small.id);
        inspection = explorer.inspect();
        const smallWidth = findTreeItem(
            contentGroup(inspection.contents, 'Parameters').children,
            (item) => item.label === 'WIDTH',
        );
        assert.strictEqual(smallWidth.description, 'parameter int = 8');
        const smallData = findTreeItem(
            contentGroup(inspection.contents, 'Output Ports').children,
            (item) => item.label === 'data',
        );
        assert.strictEqual(smallData.description, 'logic [7:0]');

        const smallSnapshotNode = findSnapshotNode(fakeSnapshot, small.id);
        assert.strictEqual(
            asRecord(asRecord(asArray(smallSnapshotNode.ports)[1]).type).displayType,
            'logic [7:0]',
        );
        assert.strictEqual(
            asRecord(asRecord(asArray(smallSnapshotNode.signals)[0]).type).displayType,
            'logic [7:0]',
        );

        const declarationRoots = roots.filter((item) => item.label === 'decl_only');
        assert.strictEqual(declarationRoots.length, 2, 'ambiguous declaration-only roots were not rendered');
        const declarationDescriptions = declarationRoots.map((item) => item.description ?? '');
        assert.ok(declarationDescriptions[0].includes('declaration-a.sv'));
        assert.ok(declarationDescriptions[1].includes('declaration-b.sv'));
        assert.ok(declarationDescriptions.every((description) => description.includes('declaration-only')));
        assert.ok(declarationDescriptions.every((description) => description.includes('ambiguous definition')));
        assert.notStrictEqual(declarationDescriptions[0], declarationDescriptions[1]);
    });

    it('provides llg.toml completion and hover without language-server participation', async () => {
        const configUri = vscode.Uri.file(path.join(workspaceFolder().uri.fsPath, 'llg.toml'));
        const document = await vscode.workspace.openTextDocument(configUri);
        const sourceSection = document.getText().indexOf('[sources]');
        const insertion = document.positionAt(sourceSection + '[sources]'.length + 1);

        const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            configUri,
            insertion,
        );
        const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            configUri,
            document.positionAt(sourceSection + 2),
        );

        assert.ok(completions.items.some((item) => item.label === 'directories'));
        assert.ok(hover.some((item) => item.contents.some((content) => {
            if (typeof content === 'string') {
                return content.includes('[sources]');
            }
            return 'value' in content && content.value.includes('[sources]');
        })));
    });

    it('associates Tcl, SDC, and XDC files with their shared editor configuration', async () => {
        const folder = workspaceFolder();
        const softbrush = vscode.workspace.getConfiguration('hdlsupport.softbrush', folder.uri);
        await softbrush.update('enabled', false, vscode.ConfigurationTarget.Workspace);

        for (const [extension, languageId] of [
            ['tcl', 'tcl'],
            ['sdc', 'sdc'],
            ['xdc', 'xdc'],
        ] as const) {
            const uri = vscode.Uri.file(path.join(folder.uri.fsPath, `editor-profile.${extension}`));
            await vscode.workspace.fs.writeFile(uri, Buffer.from('set value 1\n'));
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await showEditorForCommands(document);

            assert.strictEqual(document.languageId, languageId);
            editor.selection = new vscode.Selection(0, 0, 0, 0);
            // VS Code reads a language's configuration file asynchronously when the
            // first document of that language opens, so retry until comments apply.
            await pollUntil(async () => {
                await vscode.commands.executeCommand('editor.action.commentLine');
                return /^# ?set value 1$/.test(document.lineAt(0).text) ? true : null;
            }, 10_000);
            assert.match(document.lineAt(0).text, /^# ?set value 1$/);
            await vscode.commands.executeCommand('editor.action.commentLine');
            assert.strictEqual(document.lineAt(0).text, 'set value 1');

            const end = document.lineAt(0).range.end;
            editor.selection = new vscode.Selection(end, end);
            await vscode.commands.executeCommand('default:type', { text: '[' });
            assert.strictEqual(document.lineAt(0).text, 'set value 1[]');
            assert.deepStrictEqual(editor.selection.active, new vscode.Position(0, end.character + 1));
        }
    });

    it('auto-closes brackets inside braced Tcl script bodies', async () => {
        const folder = workspaceFolder();
        const uri = vscode.Uri.file(path.join(folder.uri.fsPath, 'braced-body.tcl'));
        await vscode.workspace.fs.writeFile(uri, Buffer.from('proc p {} {\n    \n}\n'));
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await showEditorForCommands(document);

        // Braced script bodies are strings in the grammar, as in Softbrush, but
        // their `string.braced` token type keeps brackets auto-closing inside them.
        // Tokenization is asynchronous, so retry until the body line is tokenized.
        const typed = await pollUntil(async () => {
            await editor.edit((edit) => edit.replace(document.lineAt(1).range, '    '));
            editor.selection = new vscode.Selection(1, 4, 1, 4);
            await vscode.commands.executeCommand('default:type', { text: '[' });
            return document.lineAt(1).text === '    []' ? document.lineAt(1).text : null;
        }, 10_000);
        assert.strictEqual(typed, '    []');
    });

    it('resolves literal include links and exposes external-linter quick actions', async () => {
        const folder = workspaceFolder();
        const includeUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'defs.svh'));
        const sourceUri = vscode.Uri.file(path.join(folder.uri.fsPath, 'include-link.sv'));
        await vscode.workspace.fs.writeFile(includeUri, Buffer.from('`define WIDTH 8\n'));
        await vscode.workspace.fs.writeFile(sourceUri, Buffer.from('`include "defs.svh"\nmodule include_link; endmodule\n'));
        const document = await vscode.workspace.openTextDocument(sourceUri);
        const diagnostics = vscode.languages.createDiagnosticCollection('hdlsupport-host-external-lint');
        const tokenSource = new vscode.CancellationTokenSource();
        try {
            const testApi = extension.exports as HdlSupportTestApi;
            const provided = await testApi.includeLinks.provider.provideDocumentLinks(document, tokenSource.token);
            const links = await Promise.all((provided ?? []).map(async (link) =>
                await testApi.includeLinks.provider.resolveDocumentLink?.(link, tokenSource.token) ?? link,
            ));
            assert.strictEqual(links.length, 1);
            assert.strictEqual(links[0].target?.toString(), includeUri.toString());

            const issue = new vscode.Diagnostic(
                new vscode.Range(1, 7, 1, 19),
                'signal is unused',
                vscode.DiagnosticSeverity.Warning,
            );
            issue.source = 'verilator';
            issue.code = 'UNUSEDSIGNAL';
            diagnostics.set(sourceUri, [issue]);
            const actions = await vscode.commands.executeCommand<Array<vscode.Command | vscode.CodeAction>>(
                'vscode.executeCodeActionProvider',
                sourceUri,
                issue.range,
            );
            const titles = actions.map((action) => action.title);
            assert.ok(titles.includes('Waive verilator:unusedsignal on this line'));
            assert.ok(titles.includes('Waive verilator:unusedsignal in this workspace'));
            assert.ok(titles.includes('Open documentation for verilator:unusedsignal'));
        } finally {
            tokenSource.dispose();
            diagnostics.dispose();
        }
    });

    it('clears forwarded Lapligence diagnostics after an empty server publication', async () => {
        const topUri = vscode.Uri.file(path.join(workspaceFolder().uri.fsPath, 'top.sv'));
        const childUri = vscode.Uri.file(path.join(workspaceFolder().uri.fsPath, 'child.sv'));
        await pollUntil(() => vscode.languages.getDiagnostics(childUri).some((candidate) =>
            candidate.source === 'llg-lint' && candidate.code === 'unused-signal',
        ) ? true : null, 20_000);
        const document = await vscode.workspace.openTextDocument(topUri);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(topUri, document.positionAt(document.getText().length), ' ');
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);

        await pollUntil(() => vscode.languages.getDiagnostics(topUri).length === 0 ? true : null, 20_000);
        assert.deepStrictEqual(vscode.languages.getDiagnostics(topUri), []);
        assert.ok(vscode.languages.getDiagnostics(childUri).some((candidate) =>
            candidate.source === 'llg-lint' && candidate.code === 'unused-signal',
        ), 'clearing top.sv diagnostics must not clear child.sv diagnostics');
    });

    mochaHooks.after(async () => {
        // The extension normally owns graceful LSP shutdown. Clean every
        // recorded launch as a bounded fallback, including failed tests;
        // the helper uses taskkill on Windows and signals only on POSIX.
        const failures = await terminateRecordedProcesses(CONTROL_DIR, {
            onWarning: (message) => console.warn(`[clientHost] ${message}`),
        });
        if (failures.length > 0) {
            throw new Error(`client-host cleanup left live fake-server process(es): ${failures.join(', ')}`);
        }
    });
});
