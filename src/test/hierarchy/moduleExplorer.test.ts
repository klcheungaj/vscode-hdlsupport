// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('vscode', () => {
    class Disposable {
        constructor(private readonly onDispose: () => void = () => undefined) {}

        dispose(): void {
            this.onDispose();
        }
    }

    class EventEmitter<T = unknown> {
        private readonly listeners = new Set<(value: T) => void>();

        readonly event = (listener: (value: T) => void): Disposable => {
            this.listeners.add(listener);
            return new Disposable(() => this.listeners.delete(listener));
        };

        fire(value: T): void {
            for (const listener of [...this.listeners]) {
                listener(value);
            }
        }

        dispose(): void {
            this.listeners.clear();
        }
    }

    class TreeItem {
        id?: string;
        description?: string;
        tooltip?: string;
        contextValue?: string;
        collapsibleState?: number;
        command?: unknown;

        constructor(readonly label: string) {}
    }

    class Uri {
        private constructor(readonly value: string) {}

        static parse(value: string): Uri {
            return new Uri(value);
        }

        toString(): string {
            return this.value;
        }

        get fsPath(): string {
            return this.value.replace(/^file:\/\//, '');
        }
    }

    const views = new Map<string, { treeDataProvider: unknown; selection: EventEmitter<unknown> }>();
    const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
    const executeCommand = vi.fn();
    const noopEvent = (): Disposable => new Disposable();

    return {
        Disposable,
        EventEmitter,
        TreeItem,
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        SymbolKind: { Module: 1, Object: 18 },
        Uri,
        Range: class Range {
            constructor(readonly startLine: number, readonly startCharacter: number,
                readonly endLine: number, readonly endCharacter: number) {}
        },
        commands: {
            executeCommand,
            registerCommand: (name: string, handler: (...args: unknown[]) => unknown): Disposable => {
                commandHandlers.set(name, handler);
                return new Disposable(() => commandHandlers.delete(name));
            },
        },
        workspace: {
            textDocuments: [],
            asRelativePath: (uri: Uri): string => uri.fsPath,
            onDidSaveTextDocument: noopEvent,
            onDidOpenTextDocument: noopEvent,
        },
        window: {
            visibleTextEditors: [],
            createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
                const selection = new EventEmitter<unknown>();
                views.set(id, { treeDataProvider: options.treeDataProvider, selection });
                return {
                    onDidChangeSelection: selection.event,
                    dispose: () => undefined,
                };
            },
            showTextDocument: vi.fn(),
            showInformationMessage: vi.fn(),
        },
        __reset: () => {
            views.clear();
            commandHandlers.clear();
            executeCommand.mockReset();
        },
        __views: views,
        __commandHandlers: commandHandlers,
    };
});

import * as vscode from 'vscode';
import {
    collectExplorerData,
    fallbackRootsFromRecords,
    registerModuleExplorer,
} from '../../hierarchy/moduleExplorer';
import type { LlgClientManager, LlgModuleExplorerSnapshot } from '../../languageServer/llgClient';
import {
    createSnapshotNormalizationBudget,
    MAX_SNAPSHOT_NORMALIZATION_ITEMS,
} from '../../hierarchy/moduleExplorerSnapshot';

const vscodeTestApi = vscode as typeof vscode & {
    __reset(): void;
    __views: Map<string, { treeDataProvider: any; selection: { fire(value: unknown): void } }>;
    __commandHandlers: Map<string, (...args: unknown[]) => unknown>;
};

const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
};
const WORKSPACE_SYMBOLS_COMMAND = 'vscode.executeWorkspaceSymbolProvider';

const originalExplorerE2eFlag = process.env.HDLSUPPORT_E2E_EXPLORER;

function context(): vscode.ExtensionContext {
    return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function snapshot(version: string): LlgModuleExplorerSnapshot {
    return {
        modules: [
            {
                id: `module:${version}:top`,
                name: `top_${version}`,
                uri: `file:///workspace/${version}.sv`,
                ports: [],
                params: [],
                signals: [],
            },
        ],
        roots: [{
            id: `instance:${version}:top`,
            instanceName: `top_${version}`,
            moduleType: `top_${version}`,
            definitionId: `module:${version}:top`,
            uri: `file:///workspace/${version}.sv`,
            children: [],
        }],
    };
}

async function settle(): Promise<void> {
    // Promise turns are sufficient for the async refresh chain and also work
    // while Jest fake timers are active for the debounce test.
    for (let i = 0; i < 8; i++) {
        await Promise.resolve();
    }
}

function legacyRange(line: number): Record<string, Record<string, number>> {
    return {
        start: { line, character: 0 },
        end: { line, character: 1 },
    };
}

function legacyDocumentSymbol(
    name: string,
    kind: number,
    line: number,
    children: unknown[] = [],
): Record<string, unknown> {
    return {
        name,
        kind,
        range: legacyRange(line),
        selectionRange: legacyRange(line),
        children,
    };
}

function hierarchyOutputCounts(roots: readonly any[]): { entries: number; contents: number; markers: number } {
    const stack: any[] = [];
    for (let index = roots.length - 1; index >= 0; index -= 1) {
        stack.push(roots[index]);
    }
    let entries = 0;
    let contents = 0;
    let markers = 0;
    while (stack.length > 0) {
        const value = stack.pop();
        entries += 1;
        if (value?.isBudgetTruncated === true) {
            markers += 1;
        }
        contents += (value?.ports?.length ?? 0) + (value?.params?.length ?? 0) + (value?.signals?.length ?? 0);
        for (let index = (value?.children?.length ?? 0) - 1; index >= 0; index -= 1) {
            stack.push(value.children[index]);
        }
    }
    return { entries, contents, markers };
}

describe('registerModuleExplorer', () => {
    beforeEach(() => {
        vscodeTestApi.__reset();
        vi.useRealTimers();
        vi.clearAllMocks();
        delete process.env.HDLSUPPORT_E2E_EXPLORER;
    });

    afterEach(() => {
        if (originalExplorerE2eFlag === undefined) {
            delete process.env.HDLSUPPORT_E2E_EXPLORER;
        } else {
            process.env.HDLSUPPORT_E2E_EXPLORER = originalExplorerE2eFlag;
        }
    });

    it('renders recursive server roots and preserves a selected definition for contents', async () => {
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                modules: [{
                    id: 'module:top',
                    name: 'top',
                    uri: 'file:///workspace/top.sv',
                    ports: [{ name: 'clk', direction: 'input', type: { kind: 'logic', width: 1 } }],
                    params: [],
                    signals: [],
                }],
                roots: [
                    {
                        id: 'instance:top',
                        instanceName: 'top',
                        moduleType: 'top',
                        definitionId: 'module:top',
                        uri: 'file:///workspace/top.sv',
                        children: [{
                            id: 'instance:top.u_child',
                            instanceName: 'u_child',
                            moduleType: 'child',
                            uri: 'file:///workspace/child.sv',
                            children: [],
                        }],
                    },
                    {
                        id: 'instance:second',
                        instanceName: 'second',
                        moduleType: 'second',
                        uri: 'file:///workspace/second.sv',
                        children: [],
                    },
                ],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        registerModuleExplorer(context(), logger as any, manager);
        await settle();

        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        expect(hierarchy.getChildren().map((item: any) => item.root.name)).toEqual(['top', 'second']);
        const root = hierarchy.getChildren()[0];
        expect(hierarchy.getChildren(root)[0].node).toMatchObject({
            instanceName: 'u_child',
            moduleType: 'child',
        });

        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [root] });
        expect(contents.getChildren()[0]).toMatchObject({ kind: 'group', label: 'Input Ports' });
    });

    it('navigates a nested hierarchy item to its instantiation and contents leaves to declarations', async () => {
        const parentUri = 'file:///workspace/top.sv';
        const definitionUri = 'file:///workspace/child.sv';
        const definitionRange = { startLine: 1, startCharacter: 0, endLine: 5, endCharacter: 1 };
        const instantiationRange = { startLine: 18, startCharacter: 4, endLine: 18, endCharacter: 12 };
        const declarationRange = { startLine: 4, startCharacter: 17, endLine: 4, endCharacter: 24 };
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                modules: [{
                    id: 'module:child',
                    name: 'child',
                    uri: definitionUri,
                    range: definitionRange,
                }],
                roots: [{
                    id: 'instance:top',
                    instanceName: 'top',
                    moduleType: 'top',
                    uri: parentUri,
                    children: [{
                        id: 'instance:top.u_child',
                        instanceName: 'u_child',
                        moduleType: 'child',
                        definitionId: 'module:child',
                        // This is the parent-file instantiation site, not the
                        // child module definition below.
                        uri: parentUri,
                        range: instantiationRange,
                        contentSource: 'elaborated',
                        ports: [{
                            name: 'payload',
                            direction: 'output',
                            type: { kind: 'logic', width: 8 },
                            location: { uri: definitionUri, range: declarationRange },
                        }],
                        children: [],
                    }],
                }],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        registerModuleExplorer(context(), logger as any, manager);
        await settle();

        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        const root = hierarchy.getChildren()[0];
        const nested = hierarchy.getChildren(root)[0];
        const gotoDefinition = vscodeTestApi.__commandHandlers.get('hdlsupport.modules.gotoDefinition');
        expect(gotoDefinition).toBeDefined();

        const hierarchyCommand = hierarchy.getTreeItem(nested).command as { arguments?: unknown[] };
        await gotoDefinition!(...(hierarchyCommand.arguments ?? []));
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({ value: parentUri }),
            expect.objectContaining({
                preview: true,
                selection: expect.objectContaining({
                    startLine: instantiationRange.startLine,
                    startCharacter: instantiationRange.startCharacter,
                    endLine: instantiationRange.endLine,
                    endCharacter: instantiationRange.endCharacter,
                }),
            }),
        );

        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [nested] });
        const outputGroup = contents.getChildren().find((group: any) => group.label === 'Output Ports');
        const contentLeaf = contents.getChildren(outputGroup)[0];
        const contentCommand = contents.getTreeItem(contentLeaf).command as { arguments?: unknown[] };
        (vscode.window.showTextDocument as Mock).mockClear();
        await gotoDefinition!(...(contentCommand.arguments ?? []));
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({ value: definitionUri }),
            expect.objectContaining({
                preview: true,
                selection: expect.objectContaining({
                    startLine: declarationRange.startLine,
                    startCharacter: declarationRange.startCharacter,
                    endLine: declarationRange.endLine,
                    endCharacter: declarationRange.endCharacter,
                }),
            }),
        );
    });

    it('renders cycle and budget truncation markers independently', async () => {
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                roots: [{
                    instanceName: 'top',
                    moduleType: 'top',
                    children: [{
                        instanceName: 'u_cycle',
                        moduleType: 'loop',
                        isCycleTruncated: true,
                        children: [],
                    }, {
                        instanceName: 'u_budget',
                        moduleType: 'wide',
                        isBudgetTruncated: true,
                        children: [],
                    }],
                }],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        registerModuleExplorer(context(), logger as any, manager);
        await settle();

        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const root = hierarchy.getChildren()[0];
        const [cycle, budget] = hierarchy.getChildren(root);
        expect(hierarchy.getTreeItem(cycle).tooltip).toContain('instantiation cycle');
        expect(hierarchy.getTreeItem(cycle).tooltip).not.toContain('expansion limit');
        expect(hierarchy.getTreeItem(budget).tooltip).toContain('expansion limit');
        expect(hierarchy.getTreeItem(budget).tooltip).not.toContain('instantiation cycle');
    });

    it('renders unreachable cycle roots as one expanded non-navigable group', async () => {
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                roots: [{
                    id: 'instance:ordinary',
                    instanceName: 'ordinary',
                    moduleType: 'ordinary',
                    uri: 'file:///workspace/ordinary.sv',
                    children: [],
                }, {
                    id: 'instance:cycle:a',
                    isCycleRoot: true,
                    moduleType: 'a',
                    uri: 'file:///workspace/a.sv',
                    children: [],
                }],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        registerModuleExplorer(context(), logger as any, manager);
        await settle();

        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        const roots = hierarchy.getChildren();
        expect(roots.map((item: any) => item.root.name)).toEqual([
            'ordinary',
            '(unreachable cycles)',
        ]);

        const group = roots[1];
        const groupTreeItem = hierarchy.getTreeItem(group);
        expect(groupTreeItem.label).toBe('(unreachable cycles)');
        expect(groupTreeItem.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
        expect(groupTreeItem.command).toBeUndefined();
        expect(groupTreeItem.description).toBeUndefined();

        const cycle = hierarchy.getChildren(group)[0];
        expect(cycle.node).toMatchObject({ instanceName: 'a', moduleType: 'a' });
        expect(hierarchy.getTreeItem(cycle).command).toBeDefined();

        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [group] });
        expect(contents.getChildren()).toEqual([expect.objectContaining({
            kind: 'message',
        })]);
    });

    it('exposes the opt-in provider-backed adapter without changing the default registration surface', async () => {
        process.env.HDLSUPPORT_E2E_EXPLORER = '1';
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                modules: [],
                roots: [{
                    id: 'instance:adapter:top',
                    instanceName: 'top',
                    moduleType: 'top',
                    uri: 'file:///workspace/top.sv',
                    children: [{
                        id: 'instance:adapter:top.u_child',
                        instanceName: 'u_child',
                        moduleType: 'child',
                        contentSource: 'elaborated',
                        params: [{ name: 'WIDTH', type: { kind: 'int' }, value: '12' }],
                        ports: [],
                        signals: [],
                        children: [],
                    }],
                }],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        const adapter = registerModuleExplorer(context(), logger as any, manager);
        expect(adapter).toBeDefined();
        await adapter!.wait();
        const inspection = adapter!.inspect();
        expect(inspection.hierarchy[0]).toMatchObject({ label: 'top' });
        const child = inspection.hierarchy[0].children[0];
        expect(child).toMatchObject({
            id: 'instance:adapter:top.u_child',
            label: 'u_child',
            params: [{ name: 'WIDTH', value: '12' }],
        });

        await adapter!.select(child.id!);
        expect(adapter!.inspect().contents.map((item) => item.label)).toEqual(['Parameters']);
        await adapter!.waitForRefresh();
        expect((await adapter!.getHierarchyTreeItems())[0].label).toBe('top');
        await adapter!.selectHierarchyNode(child.id!);
        expect((await adapter!.getModuleContentsTreeItems())[0].label).toBe('Parameters');
    });

    it('uses the selected instance contents, including distinct parameter overrides and typed signals', async () => {
        const childPorts = [
            { name: 'clk', direction: 'input', type: { kind: 'logic', width: 1 } },
            { name: 'data', direction: 'output', type: { kind: 'logic', width: 8 } },
        ];
        const instance = (id: string, name: string, value: string) => ({
            id,
            instanceName: name,
            moduleType: 'child',
            definitionId: 'module:child',
            uri: 'file:///workspace/child.sv',
            contentSource: 'elaborated',
            ports: childPorts,
            params: [{
                name: 'WIDTH',
                type: { kind: 'int', width: 32 },
                value,
                local: false,
            }],
            // `data` intentionally appears as a backing net as well. The
            // contents view must keep it only in Output Ports.
            signals: [
                { name: 'data', kind: 'net', type: { kind: 'logic', width: 8 } },
                { name: 'state', kind: 'var', type: { kind: 'logic', width: 8 } },
            ],
            children: [],
        });
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                modules: [{
                    id: 'module:child',
                    name: 'child',
                    uri: 'file:///workspace/child.sv',
                    ports: childPorts,
                    params: [{ name: 'WIDTH', type: { kind: 'int', width: 32 }, value: 'default' }],
                    signals: [{ name: 'state', kind: 'var', type: { kind: 'logic', width: 8 } }],
                }],
                roots: [{
                    id: 'instance:top',
                    instanceName: 'top',
                    moduleType: 'top',
                    uri: 'file:///workspace/top.sv',
                    children: [
                        instance('instance:top.u_small', 'u_small', '8'),
                        instance('instance:top.u_wide', 'u_wide', '16'),
                    ],
                }],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        registerModuleExplorer(context(), logger as any, manager);
        await settle();

        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        const root = hierarchy.getChildren()[0];
        const [small, wide] = hierarchy.getChildren(root);

        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [small] });
        const smallGroups = contents.getChildren();
        expect(smallGroups.map((group: any) => group.label)).toEqual([
            'Parameters', 'Input Ports', 'Output Ports', 'Signals',
        ]);
        expect(smallGroups.every((group: any) => contents.getTreeItem(group).collapsibleState === 1)).toBe(true);
        const smallParameter = contents.getChildren(smallGroups[0])[0];
        expect(contents.getTreeItem(smallParameter)).toMatchObject({
            label: 'WIDTH',
            description: 'parameter int = 8',
        });
        expect(contents.getChildren(smallGroups[2]).map((entry: any) => entry.child.name)).toEqual(['data']);
        expect(contents.getChildren(smallGroups[3]).map((entry: any) => entry.child.name)).toEqual(['state']);
        expect(contents.getTreeItem(contents.getChildren(smallGroups[3])[0]).description).toBe('logic [7:0]');

        // Selecting the sibling with the same module type must switch to its
        // exact node-local parameter value, not the module record/default.
        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [wide] });
        const wideGroups = contents.getChildren();
        const wideParameter = contents.getChildren(wideGroups[0])[0];
        expect(contents.getTreeItem(wideParameter).description).toBe('parameter int = 16');
    });

    it('uses resolved widths and attaches declaration navigation to contents leaves', async () => {
        const declarationUri = 'file:///workspace/child.sv';
        const declarationRange = { startLine: 7, startCharacter: 4, endLine: 7, endCharacter: 8 };
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                roots: [{
                    id: 'instance:resolved:top',
                    instanceName: 'top',
                    moduleType: 'top',
                    // This is intentionally a different location: contents
                    // rows must navigate to their declaration, not here.
                    uri: 'file:///workspace/top_inst.sv',
                    range: { startLine: 20, startCharacter: 0, endLine: 20, endCharacter: 5 },
                    contentSource: 'elaborated',
                    ports: [{
                        name: 'data',
                        direction: 'output',
                        detail: 'output logic [WIDTH - 1 : 0] data',
                        type: { kind: 'logic', width: 8 },
                        resolvedDisplayType: 'output logic [ 7 : 0 ]',
                        location: { uri: declarationUri, range: declarationRange },
                    }],
                    params: [{
                        name: 'WIDTH',
                        type: { kind: 'int', width: 32 },
                        value: '8',
                        location: { uri: declarationUri, range: declarationRange },
                    }],
                    signals: [{
                        name: 'tri_state',
                        kind: 'tri',
                        type: { kind: 'logic', width: 4 },
                        location: { uri: declarationUri, range: declarationRange },
                    }],
                    children: [],
                }],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        registerModuleExplorer(context(), logger as any, manager);
        await settle();

        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        const root = hierarchy.getChildren()[0];
        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [root] });

        const groups = contents.getChildren();
        expect(groups.map((group: any) => group.label)).toEqual(['Parameters', 'Output Ports', 'Signals']);
        const output = contents.getChildren(groups[1])[0];
        const outputTreeItem = contents.getTreeItem(output);
        expect(outputTreeItem).toMatchObject({
            label: 'data',
            description: 'logic [7:0]',
            command: {
                command: 'hdlsupport.modules.gotoDefinition',
                title: 'Go to Declaration',
                arguments: [expect.objectContaining({ uri: declarationUri, range: declarationRange })],
            },
        });
        const outputCommand = outputTreeItem.command as { arguments?: unknown[] };
        const gotoDefinition = vscodeTestApi.__commandHandlers.get('hdlsupport.modules.gotoDefinition');
        expect(gotoDefinition).toBeDefined();
        await gotoDefinition!(...(outputCommand.arguments ?? []));
        const showTextDocument = vscode.window.showTextDocument as Mock;
        expect(showTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({ value: declarationUri }),
            expect.objectContaining({
                preview: true,
                selection: expect.objectContaining({
                    startLine: declarationRange.startLine,
                    startCharacter: declarationRange.startCharacter,
                    endLine: declarationRange.endLine,
                    endCharacter: declarationRange.endCharacter,
                }),
            }),
        );
        const parameter = contents.getChildren(groups[0])[0];
        expect(contents.getTreeItem(parameter)).toMatchObject({
            label: 'WIDTH',
            description: 'parameter int = 8',
            command: {
                arguments: [expect.objectContaining({ uri: declarationUri, range: declarationRange })],
            },
        });
        const signal = contents.getChildren(groups[2])[0];
        expect(contents.getTreeItem(signal)).toMatchObject({
            label: 'tri_state',
            description: 'tri logic [3:0]',
            command: {
                command: 'hdlsupport.modules.gotoDefinition',
                arguments: [expect.objectContaining({ uri: declarationUri, range: declarationRange })],
            },
        });
    });

    it('does not combine a preferred declaration URI with a fallback range from another file', async () => {
        const preferredUri = 'file:///workspace/preferred.sv';
        const fallbackUri = 'file:///workspace/fallback.sv';
        const fallbackRange = { startLine: 12, startCharacter: 3, endLine: 12, endCharacter: 9 };
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                modules: [{
                    id: 'module:child',
                    name: 'child',
                    uri: fallbackUri,
                    ports: [{
                        name: 'data',
                        direction: 'output',
                        type: { kind: 'logic', width: 8 },
                        declarationUri: fallbackUri,
                        declarationRange: fallbackRange,
                    }],
                }],
                roots: [{
                    id: 'instance:top',
                    instanceName: 'top',
                    moduleType: 'top',
                    children: [{
                        id: 'instance:top.u_child',
                        instanceName: 'u_child',
                        moduleType: 'child',
                        definitionId: 'module:child',
                        contentSource: 'elaborated',
                        ports: [{
                            name: 'data',
                            direction: 'output',
                            type: { kind: 'logic', width: 8 },
                            declarationUri: preferredUri,
                        }],
                        children: [],
                    }],
                }],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        registerModuleExplorer(context(), logger as any, manager);
        await settle();

        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        const root = hierarchy.getChildren()[0];
        const child = hierarchy.getChildren(root)[0];
        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [child] });

        const outputGroup = contents.getChildren().find((group: any) => group.label === 'Output Ports');
        const contentLeaf = contents.getChildren(outputGroup)[0];
        const treeItem = contents.getTreeItem(contentLeaf);
        expect(treeItem.command).toMatchObject({
            command: 'hdlsupport.modules.gotoDefinition',
            arguments: [expect.objectContaining({ uri: preferredUri })],
        });
        const target = (treeItem.command as { arguments?: unknown[] }).arguments?.[0] as Record<string, unknown>;
        expect(target).not.toHaveProperty('range');

        const gotoDefinition = vscodeTestApi.__commandHandlers.get('hdlsupport.modules.gotoDefinition');
        await gotoDefinition!((treeItem.command as { arguments?: unknown[] }).arguments?.[0]);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({ value: preferredUri }),
            { preview: true },
        );
    });

    it('preserves a preferred URI-only declaration when the fallback uses the same URI with a range', async () => {
        const preferredUri = 'file:///workspace/preferred.sv';
        const fallbackRange = { startLine: 12, startCharacter: 3, endLine: 12, endCharacter: 9 };
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                modules: [{
                    id: 'module:child',
                    name: 'child',
                    uri: preferredUri,
                    ports: [{
                        name: 'data',
                        direction: 'output',
                        type: { kind: 'logic', width: 8 },
                        declarationUri: preferredUri,
                        declarationRange: fallbackRange,
                    }],
                }],
                roots: [{
                    id: 'instance:top',
                    instanceName: 'top',
                    moduleType: 'top',
                    children: [{
                        id: 'instance:top.u_child',
                        instanceName: 'u_child',
                        moduleType: 'child',
                        definitionId: 'module:child',
                        contentSource: 'elaborated',
                        ports: [{
                            name: 'data',
                            direction: 'output',
                            type: { kind: 'logic', width: 8 },
                            declarationUri: preferredUri,
                        }],
                        children: [],
                    }],
                }],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        registerModuleExplorer(context(), logger as any, manager);
        await settle();

        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        const root = hierarchy.getChildren()[0];
        const child = hierarchy.getChildren(root)[0];
        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [child] });

        const outputGroup = contents.getChildren().find((group: any) => group.label === 'Output Ports');
        const contentLeaf = contents.getChildren(outputGroup)[0];
        const treeItem = contents.getTreeItem(contentLeaf);
        const target = (treeItem.command as { arguments?: unknown[] }).arguments?.[0] as Record<string, unknown>;
        expect(target).toMatchObject({ uri: preferredUri });
        expect(target).not.toHaveProperty('range');

        const gotoDefinition = vscodeTestApi.__commandHandlers.get('hdlsupport.modules.gotoDefinition');
        await gotoDefinition!(target);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({ value: preferredUri }),
            { preview: true },
        );
    });

    it('renders old contents payloads without type-display or location fields', async () => {
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                roots: [{
                    id: 'instance:old:top',
                    instanceName: 'top',
                    moduleType: 'top',
                    contentSource: 'elaborated',
                    ports: [{ name: 'clk', direction: 'input', detail: 'input   logic [ 0 : 0 ] clk' }],
                    params: [{ name: 'P', detail: 'parameter int', value: '1' }],
                    signals: [{ name: 'state', kind: 'var', detail: 'logic [ 3 : 0 ] state' }],
                    children: [],
                }],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        registerModuleExplorer(context(), logger as any, manager);
        await settle();
        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [hierarchy.getChildren()[0]] });

        const groups = contents.getChildren();
        expect(groups.map((group: any) => group.label)).toEqual(['Parameters', 'Input Ports', 'Signals']);
        expect(contents.getTreeItem(contents.getChildren(groups[1])[0]).description).toBe('logic [0:0]');
        expect(contents.getTreeItem(contents.getChildren(groups[0])[0]).description).toBe('parameter int = 1');
        expect(contents.getTreeItem(contents.getChildren(groups[0])[0]).command).toBeUndefined();
    });

    it('treats explicit empty elaborated groups as authoritative and shows useful empty text', async () => {
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                modules: [{
                    id: 'module:empty',
                    name: 'empty',
                    uri: 'file:///workspace/empty.sv',
                    params: [{ name: 'WIDTH', type: { kind: 'int' }, value: 'default' }],
                    ports: [{ name: 'clk', direction: 'input', type: { kind: 'logic' } }],
                    signals: [{ name: 'state', kind: 'var', type: { kind: 'logic' } }],
                }],
                roots: [{
                    id: 'instance:empty',
                    instanceName: 'empty',
                    moduleType: 'empty',
                    definitionId: 'module:empty',
                    contentSource: 'elaborated',
                    params: [],
                    ports: [],
                    signals: [],
                    children: [],
                }],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        registerModuleExplorer(context(), logger as any, manager);
        await settle();
        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [hierarchy.getChildren()[0]] });

        expect(contents.getChildren()).toEqual([{
            kind: 'message',
            message: 'No parameters, ports, or signals found for this module instance',
        }]);
    });

    it('renders declaration-only and ambiguous entries as annotated non-expandable leaves', async () => {
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue({
                modules: [
                    { id: 'module:dup:a', name: 'dup', uri: 'file:///workspace/a/dup.sv' },
                    { id: 'module:dup:b', name: 'dup', uri: 'file:///workspace/b/dup.sv' },
                ],
                roots: [
                    {
                        id: 'instance:dup:a',
                        instanceName: 'dup',
                        moduleType: 'dup',
                        definitionId: 'module:dup:a',
                        uri: 'file:///workspace/a/dup.sv',
                        contentSource: 'declaration',
                        isAmbiguousDefinition: true,
                        children: [{ instanceName: 'u_wrong', moduleType: 'child', children: [] }],
                    },
                    {
                        id: 'instance:dup:b',
                        instanceName: 'dup',
                        moduleType: 'dup',
                        definitionId: 'module:dup:b',
                        uri: 'file:///workspace/b/dup.sv',
                        contentSource: 'declaration',
                        isAmbiguousDefinition: true,
                        children: [],
                    },
                ],
            }),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;

        registerModuleExplorer(context(), logger as any, manager);
        await settle();

        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const roots = hierarchy.getChildren();
        expect(roots).toHaveLength(2);
        expect(roots.map((item: any) => hierarchy.getTreeItem(item).description)).toEqual([
            expect.stringContaining('declaration-only'),
            expect.stringContaining('declaration-only'),
        ]);
        expect(roots.map((item: any) => hierarchy.getTreeItem(item).tooltip)).toEqual([
            expect.stringContaining('ambiguous definition'),
            expect.stringContaining('ambiguous definition'),
        ]);
        expect(roots.every((item: any) => hierarchy.getTreeItem(item).collapsibleState === 0)).toBe(true);
        expect(hierarchy.getChildren(roots[0])).toEqual([]);
    });

    it('falls back to standard symbols when the server reports MethodNotFound compatibility', async () => {
        const manager = {
            getModuleExplorerSnapshot: vi.fn().mockResolvedValue(undefined),
            onModuleExplorerChanged: vi.fn(() => new vscode.Disposable(() => undefined)),
        } as unknown as LlgClientManager;
        const executeCommand = (vscode.commands.executeCommand as Mock);
        executeCommand.mockImplementation(async (command: string) => {
            if (command === 'vscode.executeWorkspaceSymbolProvider') {
                return [{
                    name: 'legacy_top',
                    kind: 1,
                    location: { uri: vscode.Uri.parse('file:///workspace/legacy.sv') },
                }];
            }
            return [{
                name: 'legacy_top',
                kind: 1,
                range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
                selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
                children: [
                    { name: 'clk', kind: 6, detail: 'input logic clk' },
                    { name: 'state', kind: 12, detail: 'logic [3:0] state' },
                ],
            }];
        });

        registerModuleExplorer(context(), logger as any, manager);
        await settle();

        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        expect(manager.getModuleExplorerSnapshot).toHaveBeenCalledTimes(1);
        expect(executeCommand).toHaveBeenCalledWith(
            'vscode.executeWorkspaceSymbolProvider',
            '',
        );
        expect(hierarchy.getChildren().map((item: any) => item.root.name)).toEqual(['legacy_top']);
        const root = hierarchy.getChildren()[0];
        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [root] });
        const groups = contents.getChildren();
        expect(groups.map((group: any) => group.label)).toEqual(['Input Ports', 'Signals']);
        expect(groups.every((group: any) => contents.getTreeItem(group).collapsibleState === 1)).toBe(true);
        expect(contents.getTreeItem(contents.getChildren(groups[0])[0]).description).toBe('logic');
        expect(contents.getTreeItem(contents.getChildren(groups[1])[0]).description).toBe('logic [3:0]');
    });

    it('bounds a large legacy module catalog and hierarchy with one response budget', async () => {
        const uri = 'file:///workspace/legacy-catalog.sv';
        const moduleSymbols = Array.from({ length: MAX_SNAPSHOT_NORMALIZATION_ITEMS + 1_000 }, (_, index) =>
            legacyDocumentSymbol(`legacy_${index}`, 1, index));
        const executeCommand = vscode.commands.executeCommand as Mock;
        executeCommand.mockImplementation(async (command: string) => command === WORKSPACE_SYMBOLS_COMMAND
            ? [{ name: 'legacy_0', kind: 1, location: { uri: vscode.Uri.parse(uri) } }]
            : moduleSymbols);

        const data = await collectExplorerData(undefined, logger as any);
        const counts = hierarchyOutputCounts(data.roots);
        let recordContents = 0;
        for (const record of data.records) {
            recordContents += (record.ports?.length ?? 0) +
                (record.params?.length ?? 0) + (record.signals?.length ?? 0);
        }

        expect(data.records.length).toBeGreaterThan(0);
        expect(data.records[0].name).toBe('legacy_0');
        expect(data.roots.length).toBeGreaterThan(0);
        expect(data.isBudgetTruncated).toBe(true);
        expect(counts.markers).toBe(1);
        expect(data.records.length + recordContents + counts.entries + counts.contents + counts.markers)
            .toBeLessThanOrEqual(MAX_SNAPSHOT_NORMALIZATION_ITEMS);
    });

    it('promotes only a bounded prefix when legacy roots are empty', () => {
        const records = Array.from({ length: MAX_SNAPSHOT_NORMALIZATION_ITEMS + 1_000 }, (_, index) => ({
            name: `fallback_${index}`,
            uri: `file:///workspace/fallback_${index}.sv`,
            instances: [],
        }));
        const budget = createSnapshotNormalizationBudget(1);
        const roots = fallbackRootsFromRecords(records, budget);
        const counts = hierarchyOutputCounts(roots);

        expect(roots.length).toBeGreaterThan(0);
        expect(roots[0].name).toBe('fallback_0');
        expect(roots.length).toBeLessThan(records.length);
        expect(budget.truncated).toBe(true);
        expect(counts.markers).toBe(1);
        expect(roots.at(-1)).toHaveProperty('isBudgetTruncated', true);
        expect(roots.length + counts.markers).toBeLessThanOrEqual(MAX_SNAPSHOT_NORMALIZATION_ITEMS);
    });

    it('walks a deep legacy symbol tree iteratively and exposes a deterministic marker', async () => {
        const uri = 'file:///workspace/legacy-deep.sv';
        const root = legacyDocumentSymbol('legacy_top', 1, 0);
        let cursor = root;
        const depth = MAX_SNAPSHOT_NORMALIZATION_ITEMS + 1_000;
        for (let index = 1; index <= depth; index += 1) {
            const child = legacyDocumentSymbol(`scope_${index}`, 3, index);
            (cursor.children as unknown[]).push(child);
            cursor = child;
        }
        const executeCommand = vscode.commands.executeCommand as Mock;
        executeCommand.mockImplementation(async (command: string) => command === WORKSPACE_SYMBOLS_COMMAND
            ? [{ name: 'legacy_top', kind: 1, location: { uri: vscode.Uri.parse(uri) } }]
            : [root]);

        const data = await collectExplorerData(undefined, logger as any);

        const counts = hierarchyOutputCounts(data.roots);
        expect(data.records).toHaveLength(1);
        expect(data.roots[0].name).toBe('legacy_top');
        expect(data.isBudgetTruncated).toBe(true);
        expect(counts.markers).toBe(1);
    });

    it('bounds legacy fallback contents and keeps lookup on the retained record safe', async () => {
        const uri = 'file:///workspace/legacy-content.sv';
        const portCount = MAX_SNAPSHOT_NORMALIZATION_ITEMS + 1_000;
        const module = legacyDocumentSymbol('legacy_content', 1, 0,
            Array.from({ length: portCount }, (_, index) =>
                legacyDocumentSymbol(`port_${index}`, 6, index, [])));
        const executeCommand = vscode.commands.executeCommand as Mock;
        executeCommand.mockImplementation(async (command: string) => command === WORKSPACE_SYMBOLS_COMMAND
            ? [{ name: 'legacy_content', kind: 1, location: { uri: vscode.Uri.parse(uri) } }]
            : [module]);

        const data = await collectExplorerData(undefined, logger as any);
        const counts = hierarchyOutputCounts(data.roots);
        const retainedContent = (data.records[0].ports?.length ?? 0) +
            (data.records[0].params?.length ?? 0) + (data.records[0].signals?.length ?? 0);

        expect(retainedContent).toBeGreaterThan(0);
        expect(data.isBudgetTruncated).toBe(true);
        expect(counts.markers).toBe(1);
        expect(data.records.length + retainedContent + counts.entries + counts.contents + counts.markers)
            .toBeLessThanOrEqual(MAX_SNAPSHOT_NORMALIZATION_ITEMS);

        // The bounded root may omit its duplicated content when the shared
        // budget is spent; the contents provider must safely fall back to the
        // retained definition record instead of rebuilding the raw suffix.
        registerModuleExplorer(context(), logger as any);
        await settle();
        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        const rootItem = hierarchy.getChildren()[0];
        expect(hierarchy.getTreeItem(rootItem).tooltip).toContain('snapshot normalization limit reached');
        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [rootItem] });
        const groups = contents.getChildren();
        const entries = groups.reduce(
            (total: number, group: any) => total + contents.getChildren(group).length,
            0,
        );
        expect(entries).toBeLessThanOrEqual(MAX_SNAPSHOT_NORMALIZATION_ITEMS);
        expect(entries).toBeGreaterThan(0);
    });

    it('refreshes once after a snapshot-change notification and ignores late disposal work', async () => {
        vi.useFakeTimers();
        let notify: (() => void) | undefined;
        const manager = {
            getModuleExplorerSnapshot: vi.fn()
                .mockResolvedValueOnce(snapshot('one'))
                .mockResolvedValueOnce(snapshot('two')),
            onModuleExplorerChanged: vi.fn((handler: () => void) => {
                notify = handler;
                return new vscode.Disposable(() => undefined);
            }),
        } as unknown as LlgClientManager;
        const extensionContext = context();

        registerModuleExplorer(extensionContext, logger as any, manager);
        await settle();
        expect(manager.getModuleExplorerSnapshot).toHaveBeenCalledTimes(1);

        notify?.();
        notify?.();
        vi.advanceTimersByTime(500);
        await settle();
        expect(manager.getModuleExplorerSnapshot).toHaveBeenCalledTimes(2);
        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        expect(hierarchy.getChildren()[0].root.name).toBe('top_two');

        for (const subscription of extensionContext.subscriptions) {
            subscription.dispose();
        }
        notify?.();
        vi.advanceTimersByTime(500);
        await settle();
        expect(manager.getModuleExplorerSnapshot).toHaveBeenCalledTimes(2);
    });

    it('retains selection by stable instance ID across refresh and clears it only when the node disappears', async () => {
        vi.useFakeTimers();
        let notify: (() => void) | undefined;
        const childSnapshot = (value: string, includeChild: boolean): LlgModuleExplorerSnapshot => ({
            modules: [{
                id: 'module:stable:child',
                name: 'child',
                uri: 'file:///workspace/child.sv',
                ports: [{ name: 'clk', direction: 'input', type: { kind: 'logic', width: 1 } }],
                params: [{ name: 'WIDTH', type: { kind: 'int', width: 32 }, value: value === '8' ? '8' : '9' }],
                signals: [{ name: 'state', kind: 'var', type: { kind: 'logic', width: 8 } }],
            }],
            roots: [{
                id: 'instance:stable:top',
                instanceName: 'top',
                moduleType: 'top',
                uri: 'file:///workspace/top.sv',
                children: includeChild ? [{
                    id: 'instance:stable:top.u_child',
                    instanceName: 'u_child',
                    moduleType: 'child',
                    definitionId: 'module:stable:child',
                    uri: 'file:///workspace/child.sv',
                    contentSource: 'elaborated',
                    ports: [{ name: 'clk', direction: 'input', type: { kind: 'logic', width: 1 } }],
                    params: [{ name: 'WIDTH', type: { kind: 'int', width: 32 }, value }],
                    signals: [{ name: 'state', kind: 'var', type: { kind: 'logic', width: 8 } }],
                    children: [],
                }] : [],
            }],
        });
        const manager = {
            getModuleExplorerSnapshot: vi.fn()
                .mockResolvedValueOnce(childSnapshot('8', true))
                .mockResolvedValueOnce(childSnapshot('16', true))
                .mockResolvedValueOnce(childSnapshot('16', false)),
            onModuleExplorerChanged: vi.fn((handler: () => void) => {
                notify = handler;
                return new vscode.Disposable(() => undefined);
            }),
        } as unknown as LlgClientManager;
        const extensionContext = context();

        registerModuleExplorer(extensionContext, logger as any, manager);
        await settle();
        const hierarchy = vscodeTestApi.__views.get('moduleHierarchy')?.treeDataProvider;
        const contents = vscodeTestApi.__views.get('moduleContents')?.treeDataProvider;
        const child = hierarchy.getChildren(hierarchy.getChildren()[0])[0];
        vscodeTestApi.__views.get('moduleHierarchy')?.selection.fire({ selection: [child] });

        const selectedGroup = contents.getChildren()[0];
        expect(contents.getTreeItem(contents.getChildren(selectedGroup)[0]).description).toBe('parameter int = 8');

        notify?.();
        vi.advanceTimersByTime(500);
        await settle();
        const retainedGroup = contents.getChildren()[0];
        expect(contents.getTreeItem(contents.getChildren(retainedGroup)[0]).description).toBe('parameter int = 16');

        notify?.();
        vi.advanceTimersByTime(500);
        await settle();
        expect(contents.getChildren()).toEqual([{
            kind: 'message',
            message: 'Select a module in the Module Hierarchy view',
        }]);

        for (const subscription of extensionContext.subscriptions) {
            subscription.dispose();
        }
    });
});
