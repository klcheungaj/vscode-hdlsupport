// SPDX-License-Identifier: MIT
//
// HDL Modules explorer: an activity-bar container with two tree views. Newer
// Lapligence servers provide one recursive, server-owned snapshot; older servers
// continue through the registered workspace/document symbol providers. No
// Verilog/SV providers are registered here, those stay owned by Lapligence.
//
// The symbol path remains deliberately defensive: module definitions come
// from `vscode.executeWorkspaceSymbolProvider` and their children from
// `vscode.executeDocumentSymbolProvider`. It is a compatibility path for
// servers that answer the snapshot request with MethodNotFound.
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../logger';
import type { LlgClientManager } from '../languageServer/llgClient';
import {
    availableSnapshotDataSlots,
    boundLegacyHierarchy,
    createSnapshotNormalizationBudget,
    MAX_SNAPSHOT_NORMALIZATION_ITEMS,
    noteSnapshotTruncation,
    normalizeModuleExplorerSnapshot,
    releaseSnapshotReservedSlots,
    SnapshotNormalizationBudget,
    takeSnapshotDataSlot,
    takeSnapshotRootSlot,
} from './moduleExplorerSnapshot';
import {
    ambiguousModuleNames,
    applyInstanceNameFallback,
    buildHierarchy,
    ClassifiedChild,
    classifyDocumentSymbolChildren,
    cleanDisplayPath,
    contentsEntryDescription,
    HierarchyBuildBudget,
    HierarchyNode,
    HierarchyRoot,
    ModuleRecord,
    RawSymbolChild,
    SourceRange,
    UNREACHABLE_CYCLE_GROUP_NAME,
} from './moduleHierarchy';
import { MODULES_GOTO_COMMAND, registerModuleExplorerCommands } from './moduleExplorerCommands';
import { RefreshScheduler } from './refreshScheduler';

const HIERARCHY_VIEW_ID = 'moduleHierarchy';
const CONTENTS_VIEW_ID = 'moduleContents';
const WORKSPACE_SYMBOLS_COMMAND = 'vscode.executeWorkspaceSymbolProvider';
const DOCUMENT_SYMBOLS_COMMAND = 'vscode.executeDocumentSymbolProvider';
// llg workspace_symbols substring-matches the query, so '' returns every
// declaration; other providers commonly ignore empty queries gracefully.
const WORKSPACE_SYMBOL_QUERY = '';
const MAX_DOCUMENT_SYMBOL_FILES = 200;
// Trailing-edge quiet period for auto-refresh sweeps (didOpen/didSave bursts
// collapse into one sweep; a running sweep is never overlapped — see the
// refreshScheduler wiring at the bottom of this file).
const REFRESH_DEBOUNCE_MS = 500;
const UNRESOLVED_GROUP_LABEL = '(unresolved)';
const HDL_LANGUAGE_IDS = ['verilog', 'systemverilog'];

// vscode.SymbolKind.Module is 1, but some servers leak raw LSP kinds where
// Module is 2; accept both when spotting declarations (same for instances).
function isModuleKind(kind: vscode.SymbolKind): boolean {
    return kind === vscode.SymbolKind.Module || kind === (2 as vscode.SymbolKind);
}

function isInstanceKind(kind: vscode.SymbolKind): boolean {
    return kind === vscode.SymbolKind.Object || kind === (19 as vscode.SymbolKind);
}

/** Shared explorer state mutated by refreshes and view selection. */
interface ExplorerState {
    records: ModuleRecord[];
    roots: HierarchyRoot[];
    /** Module names defined in more than one file (see ambiguousModuleNames). */
    ambiguousNames: Set<string>;
    /** Exact root/instance tree identity selected by the user. */
    selectedHierarchyId?: string;
}

export interface ModuleExplorerController {
    /** Refreshes from the server snapshot or the compatibility symbol path. */
    refresh(): Promise<void>;
    /** Opens the source location behind a tree item (command payload). */
    reveal(target: unknown): Promise<void>;
}

/** Serializable view of one provider-generated TreeItem for host e2e tests. */
export interface ModuleExplorerTestTreeItem {
    id?: string;
    label: string;
    description?: string;
    tooltip?: string;
    collapsibleState: number;
    /** Preserved only on the opt-in test adapter so host tests can invoke the provider-owned action. */
    command?: vscode.Command;
    /** Parameter values are included for host assertions on exact instances. */
    params?: Array<{ name: string; value?: string }>;
    children: ModuleExplorerTestTreeItem[];
}

/** Stable, provider-facing inspection result for the opt-in host adapter. */
export interface ModuleExplorerTestInspection {
    hierarchy: ModuleExplorerTestTreeItem[];
    contents: ModuleExplorerTestTreeItem[];
    selectedId?: string;
}

/** Test-only adapter exposed by extension activation under the e2e env flag. */
export interface ModuleExplorerTestAdapter {
    wait(): Promise<void>;
    inspect(): ModuleExplorerTestInspection;
    select(id: string): Promise<void>;
    /** Compatibility aliases used by the client-host harness. */
    waitForRefresh(timeoutMs?: number): Promise<void>;
    getHierarchyTreeItems(): Promise<readonly ModuleExplorerTestTreeItem[]>;
    selectHierarchyNode(id: string): Promise<void>;
    getModuleContentsTreeItems(): Promise<readonly ModuleExplorerTestTreeItem[]>;
}

type HierarchyItem = { root: HierarchyRoot; id: string } | { node: HierarchyNode; id: string };
type BudgetMarkedRoot = HierarchyRoot & { isBudgetTruncated?: boolean };

function displayTreeText(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const candidate = value as { label?: unknown; value?: unknown };
    if (typeof candidate.label === 'string') {
        return candidate.label;
    }
    return typeof candidate.value === 'string' ? candidate.value : undefined;
}

interface SyncTreeProvider<Item> {
    getChildren(element?: Item): Item[];
    getTreeItem(element: Item): vscode.TreeItem;
}

function inspectProviderTree<Item>(provider: SyncTreeProvider<Item>): ModuleExplorerTestTreeItem[] {
    interface InspectionFrame {
        items: Item[];
        nextIndex: number;
        output: ModuleExplorerTestTreeItem[];
    }

    const output: ModuleExplorerTestTreeItem[] = [];
    const stack: InspectionFrame[] = [{
        items: provider.getChildren(),
        nextIndex: 0,
        output,
    }];

    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.nextIndex >= frame.items.length) {
            stack.pop();
            continue;
        }

        const item = frame.items[frame.nextIndex];
        frame.nextIndex += 1;
        const treeItem = provider.getTreeItem(item);
        const label = displayTreeText(treeItem.label) ?? '';
        const description = displayTreeText(treeItem.description);
        const tooltip = displayTreeText(treeItem.tooltip);
        const hierarchyValue = item && typeof item === 'object'
            ? ('root' in item
                ? (item as { root: HierarchyRoot }).root
                : 'node' in item
                    ? (item as { node: HierarchyNode }).node
                    : undefined)
            : undefined;
        const inspected: ModuleExplorerTestTreeItem = {
            ...(treeItem.id ? { id: treeItem.id } : {}),
            label,
            ...(description ? { description } : {}),
            ...(tooltip ? { tooltip } : {}),
            collapsibleState: treeItem.collapsibleState ?? vscode.TreeItemCollapsibleState.None,
            ...(treeItem.command ? { command: treeItem.command } : {}),
            ...(hierarchyValue?.params
                ? {
                    params: [],
                }
                : {}),
            children: [],
        };

        if (hierarchyValue?.params) {
            inspected.params = [];
            for (const parameter of hierarchyValue.params) {
                inspected.params.push({
                    name: parameter.name,
                    ...(parameter.value !== undefined ? { value: parameter.value } : {}),
                });
            }
        }

        frame.output.push(inspected);
        const children = provider.getChildren(item);
        if (children.length > 0) {
            stack.push({
                items: children,
                nextIndex: 0,
                output: inspected.children,
            });
        }
    }

    return output;
}

function rootItemId(root: HierarchyRoot, index: number): string {
    return root.id ?? `top:${root.definitionId ?? root.name}:${root.uri ?? ''}:${index}`;
}

function childItemId(parentId: string, node: HierarchyNode, index: number): string {
    return node.id ?? `${parentId}/${index}:${node.instanceName ?? 'unresolved'}`;
}

function rootItems(roots: readonly HierarchyRoot[]): HierarchyItem[] {
    return roots.map((root, index) => ({ root, id: rootItemId(root, index) }));
}

function childItems(parent: HierarchyItem): HierarchyItem[] {
    const nodes = 'root' in parent ? parent.root.children : parent.node.children;
    return nodes.map((node, index) => ({ node, id: childItemId(parent.id, node, index) }));
}

function findHierarchyItem(roots: readonly HierarchyRoot[], id: string): HierarchyItem | undefined {
    const stack: HierarchyItem[] = [];
    const initial = rootItems(roots);
    for (let index = initial.length - 1; index >= 0; index -= 1) {
        stack.push(initial[index]);
    }
    while (stack.length > 0) {
        const item = stack.pop()!;
        if (item.id === id) {
            return item;
        }
        const children = childItems(item);
        for (let index = children.length - 1; index >= 0; index -= 1) {
            stack.push(children[index]);
        }
    }
    return undefined;
}

class ModuleHierarchyProvider implements vscode.TreeDataProvider<HierarchyItem>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();

    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    constructor(private readonly state: ExplorerState) {}

    dispose(): void {
        this.onDidChangeTreeDataEmitter.dispose();
    }

    fire(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    getTreeItem(item: HierarchyItem): vscode.TreeItem {
        if ('root' in item) {
            if (item.root.isSyntheticGroup) {
                const group = new vscode.TreeItem(UNREACHABLE_CYCLE_GROUP_NAME);
                group.id = item.id;
                group.contextValue = 'hdlModuleSyntheticGroup';
                group.tooltip = (item.root as BudgetMarkedRoot).isBudgetTruncated
                    ? 'Unreachable module cycles (snapshot normalization limit reached)'
                    : 'Unreachable module cycles';
                group.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
                return group;
            }
            const treeItem = new vscode.TreeItem(item.root.name);
            treeItem.id = item.id;
            treeItem.contextValue = 'hdlModule';
            // Same-named modules in different files are disambiguated by
            // their workspace-relative path (the scheme the instantiate
            // QuickPick uses); otherwise the bare file name suffices.
            const ambiguous = this.state.ambiguousNames.has(item.root.name);
            const rootPath = ambiguous && item.root.uri
                ? displayPath(item.root.uri)
                : baseName(item.root.uri);
            const ambiguousDefinition = item.root.isAmbiguousDefinition === true;
            const budgetTruncated = (item.root as BudgetMarkedRoot).isBudgetTruncated === true;
            treeItem.description = hierarchyDescription(
                rootPath,
                item.root.contentSource === 'declaration' ? 'declaration-only' : undefined,
                ambiguousDefinition ? 'ambiguous definition' : undefined,
            );
            treeItem.tooltip = hierarchyTooltip(
                item.root.uri ?? item.root.name,
                item.root.contentSource === 'declaration' ? 'declaration-only' : undefined,
                ambiguousDefinition ? 'ambiguous definition' : undefined,
                budgetTruncated ? 'snapshot normalization limit reached' : undefined,
            );
            treeItem.collapsibleState = toCollapsible(
                item.root.children.length > 0 && !ambiguousDefinition && !ambiguous,
            );
            treeItem.command = {
                command: MODULES_GOTO_COMMAND,
                title: 'Go to Definition',
                arguments: [item],
            };
            return treeItem;
        }

        const node = item.node;
        if (node.isUnresolvedGroup) {
            const group = new vscode.TreeItem(UNRESOLVED_GROUP_LABEL);
            group.id = item.id;
            group.tooltip =
                'Instances whose instantiated module type could not be determined from the language symbols.';
            group.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
            return group;
        }

        if (node.isGenerateScope) {
            const group = new vscode.TreeItem(node.instanceName ?? 'generate');
            group.id = item.id;
            group.description = 'generate';
            group.tooltip = node.instanceName ?? 'Generated scope';
            group.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
            return group;
        }

        const treeItem = new vscode.TreeItem(node.instanceName ?? '');
        treeItem.id = item.id;
        const ambiguousDefinition = node.isAmbiguousDefinition === true;
        const ambiguousName = node.moduleType !== undefined && this.state.ambiguousNames.has(node.moduleType);
        const moduleDescription = node.moduleType !== undefined
            ? this.state.ambiguousNames.has(node.moduleType) && node.uri
                ? `${node.moduleType} (${displayPath(node.uri)})`
                : node.moduleType
            : undefined;
        treeItem.description = hierarchyDescription(
            moduleDescription,
            node.contentSource === 'declaration' ? 'declaration-only' : undefined,
            ambiguousDefinition ? 'ambiguous definition' : undefined,
        );
        treeItem.tooltip = hierarchyTooltip(
            node.isCycleTruncated
                ? `${node.instanceName} : ${node.moduleType} (instantiation cycle - not expanded further)`
                : node.isBudgetTruncated
                    ? `${node.instanceName} : ${node.moduleType} (hierarchy expansion limit reached)`
                    : [node.instanceName, node.moduleType].filter(Boolean).join(' : '),
            node.contentSource === 'declaration' ? 'declaration-only' : undefined,
            ambiguousDefinition ? 'ambiguous definition' : undefined,
        );
        treeItem.collapsibleState = toCollapsible(
            node.children.length > 0 && !ambiguousDefinition && !ambiguousName,
        );
        if (node.uri) {
            treeItem.command = {
                command: MODULES_GOTO_COMMAND,
                title: 'Go to Definition',
                arguments: [item],
            };
        }
        return treeItem;
    }

    getChildren(element?: HierarchyItem): HierarchyItem[] {
        if (!element) {
            return rootItems(this.state.roots);
        }
        if ('root' in element && element.root.isSyntheticGroup) {
            return childItems(element);
        }
        if (('root' in element &&
                (element.root.isAmbiguousDefinition || this.state.ambiguousNames.has(element.root.name))) ||
            ('node' in element &&
                (element.node.isAmbiguousDefinition ||
                    (element.node.moduleType !== undefined && this.state.ambiguousNames.has(element.node.moduleType))))) {
            return [];
        }
        return childItems(element);
    }
}

function toCollapsible(hasChildren: boolean): vscode.TreeItemCollapsibleState {
    return hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
}

function baseName(uri?: string): string | undefined {
    return uri ? path.basename(uri.replace(/\/$/, '')) : undefined;
}

function hierarchyDescription(base: string | undefined, ...annotations: Array<string | undefined>): string | undefined {
    const suffix = annotations.filter((annotation): annotation is string => annotation !== undefined);
    if (!base) {
        return suffix.length > 0 ? suffix.join(' · ') : undefined;
    }
    return suffix.length > 0 ? `${base} · ${suffix.join(' · ')}` : base;
}

function hierarchyTooltip(base: string, ...annotations: Array<string | undefined>): string {
    const suffix = annotations.filter((annotation): annotation is string => annotation !== undefined);
    return suffix.length > 0 ? `${base} (${suffix.join(', ')})` : base;
}

/**
 * Workspace-relative display path of a stringified uri, formatted like the
 * instantiate QuickPick (asRelativePath + cleanDisplayPath); falls back to
 * the bare file name outside any workspace folder.
 */
function displayPath(uriString: string): string {
    try {
        return cleanDisplayPath(vscode.workspace.asRelativePath(vscode.Uri.parse(uriString)));
    } catch {
        return baseName(uriString) ?? uriString;
    }
}

type ContentsGroupLabel = 'Parameters' | 'Input Ports' | 'Output Ports' | 'Inout Ports' | 'Ports' | 'Signals';

interface ContentGroupItem {
    kind: 'group';
    label: ContentsGroupLabel;
    entries: ClassifiedChild[];
    id: string;
}

interface ContentEntryItem {
    kind: 'entry';
    groupLabel: ContentsGroupLabel;
    child: ClassifiedChild;
    id: string;
}

interface ContentMessageItem {
    kind: 'message';
    message: string;
}

type ContentsItem = ContentGroupItem | ContentEntryItem | ContentMessageItem;

class ModuleContentsProvider implements vscode.TreeDataProvider<ContentsItem>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();

    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    constructor(private readonly state: ExplorerState) {}

    dispose(): void {
        this.onDidChangeTreeDataEmitter.dispose();
    }

    fire(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    getTreeItem(item: ContentsItem): vscode.TreeItem {
        if (item.kind === 'message') {
            return new vscode.TreeItem(item.message);
        }
        if (item.kind === 'group') {
            const group = new vscode.TreeItem(item.label);
            group.id = item.id;
            // The test-only desktop/host harness keeps the stable groups open
            // so instance-specific values are immediately visible. Production
            // retains the normal collapsed tree behavior.
            group.collapsibleState = process.env.HDLSUPPORT_TEST_MODE === '1'
                ? vscode.TreeItemCollapsibleState.Expanded
                : vscode.TreeItemCollapsibleState.Collapsed;
            return group;
        }
        const entry = new vscode.TreeItem(item.child.name);
        entry.id = item.id;
        entry.description = contentsEntryDescription(item.child.detail, item.child);
        if (item.child.uri) {
            // Reuse the already-registered, guarded explorer navigation
            // command. The payload is the CONTENTS declaration location, not
            // the selected hierarchy node (whose range is an instantiation
            // site for elaborated entries).
            entry.command = {
                command: MODULES_GOTO_COMMAND,
                title: 'Go to Declaration',
                arguments: [item.child],
            };
        }
        return entry;
    }

    getChildren(element?: ContentsItem): ContentsItem[] {
        if (!element) {
            const selectedId = this.state.selectedHierarchyId;
            const selected = selectedId
                ? findHierarchyItem(this.state.roots, selectedId)
                : undefined;
            if (!selected) {
                return [{ kind: 'message', message: 'Select a module in the Module Hierarchy view' }];
            }
            const contents = contentsForHierarchyItem(selected, this.state.records);
            const groups = contentGroupsFor(contents);
            if (groups.length === 0) {
                return [{ kind: 'message', message: 'No parameters, ports, or signals found for this module instance' }];
            }
            const identity = selected.id;
            return groups.map((group, index) => ({
                kind: 'group',
                label: group.label,
                entries: group.entries,
                id: `contents:${identity}:${index}`,
            }));
        }
        if (element.kind !== 'group') {
            return [];
        }
        return element.entries.map((child, index) => ({
            kind: 'entry',
            groupLabel: element.label,
            child,
            id: `${element.id}/${index}:${child.name}`,
        }));
    }
}

interface ModuleContentsData {
    ports?: ClassifiedChild[];
    params?: ClassifiedChild[];
    signals?: ClassifiedChild[];
}

function findModuleRecord(
    records: readonly ModuleRecord[],
    definitionId: string | undefined,
    name: string | undefined,
    uri: string | undefined,
): ModuleRecord | undefined {
    if (definitionId !== undefined) {
        const byId = records.find((record) => record.id === definitionId);
        if (byId) {
            return byId;
        }
    }
    if (!name) {
        return undefined;
    }
    return records.find((record) =>
        record.name === name && (uri === undefined || uri === '' || record.uri === uri),
    );
}

/**
 * Resolves contents for the exact selected hierarchy occurrence. New llg
 * snapshots attach authoritative arrays to every instance, including empty
 * arrays and per-instance parameter values. Missing arrays are the old-server
 * compatibility seam and may use the definition-level module record.
 */
function contentsForHierarchyItem(
    item: HierarchyItem,
    records: readonly ModuleRecord[],
): ModuleContentsData {
    if ('root' in item && item.root.isSyntheticGroup) {
        return {};
    }
    const value = 'root' in item ? item.root : item.node;
    const name = 'root' in item ? item.root.name : item.node.moduleType;
    const fallback = findModuleRecord(records, value.definitionId, name, value.uri);
    const direct = {
        ports: value.ports,
        params: value.params,
        signals: value.signals,
    };

    // An explicitly supplied group is authoritative, including an explicit
    // empty array. For omitted groups, the definition record is the
    // compatibility fallback used by older snapshots and declaration-backed
    // entries. When both exist, only missing location metadata is borrowed;
    // resolved elaborated display text and values are never overwritten by a
    // symbolic definition fallback.
    return {
        ports: mergeContentChildren(direct.ports, fallback?.ports),
        params: mergeContentChildren(direct.params, fallback?.params),
        signals: mergeContentChildren(direct.signals, fallback?.signals),
    };
}

function mergeContentChildren(
    preferred: ClassifiedChild[] | undefined,
    fallback: ClassifiedChild[] | undefined,
): ClassifiedChild[] | undefined {
    if (preferred === undefined) {
        if (fallback === undefined || fallback.length <= MAX_SNAPSHOT_NORMALIZATION_ITEMS) {
            return fallback;
        }
        return fallback.slice(0, MAX_SNAPSHOT_NORMALIZATION_ITEMS);
    }
    if (fallback === undefined || fallback.length === 0) {
        return preferred.length <= MAX_SNAPSHOT_NORMALIZATION_ITEMS
            ? preferred
            : preferred.slice(0, MAX_SNAPSHOT_NORMALIZATION_ITEMS);
    }
    const fallbackByName = new Map<string, ClassifiedChild>();
    const fallbackLimit = Math.min(fallback.length, MAX_SNAPSHOT_NORMALIZATION_ITEMS);
    for (let index = 0; index < fallbackLimit; index += 1) {
        const child = fallback[index];
        fallbackByName.set(child.name, child);
    }
    const merged: ClassifiedChild[] = [];
    const preferredLimit = Math.min(preferred.length, MAX_SNAPSHOT_NORMALIZATION_ITEMS);
    for (let index = 0; index < preferredLimit; index += 1) {
        const child = preferred[index];
        const fallbackChild = fallbackByName.get(child.name);
        if (!fallbackChild) {
            merged.push(child);
            continue;
        }
        const preferredLocationAbsent = child.uri === undefined && child.range === undefined;
        const fallbackLocation = {
            ...(fallbackChild.uri !== undefined ? { uri: fallbackChild.uri } : {}),
            ...(fallbackChild.range !== undefined ? { range: fallbackChild.range } : {}),
        };

        // A location is one declaration authority. Copy the normalized
        // fallback location only when the preferred child has no location at
        // all; otherwise preserve the preferred location, including partial
        // URI-only or range-only results.
        merged.push({
            ...child,
            ...(preferredLocationAbsent ? fallbackLocation : {}),
        });
    }
    return merged;
}

/** Ports are split by direction when the detail text starts with one. */
function contentGroupsFor(contents: ModuleContentsData): Array<{ label: ContentsGroupLabel; entries: ClassifiedChild[] }> {
    const groups: Array<{ label: ContentsGroupLabel; entries: ClassifiedChild[] }> = [];
    const push = (label: ContentsGroupLabel, entries?: ClassifiedChild[]): void => {
        if (entries && entries.length > 0) {
            groups.push({ label, entries });
        }
    };
    const ports = uniqueChildren(contents.ports);
    push('Parameters', uniqueChildren(contents.params));
    for (const direction of ['input', 'output', 'inout'] as const) {
        push(
            direction === 'input' ? 'Input Ports' : direction === 'output' ? 'Output Ports' : 'Inout Ports',
            ports.filter((port) => port.detail?.toLowerCase().startsWith(direction)),
        );
    }
    push('Ports', ports.filter((port) => !hasPortDirection(port)));
    // Some old server payloads exposed the same port as a backing net. A
    // signal with a port name is never displayed in Signals, even when the
    // normalizer was bypassed by the legacy symbol path.
    const portNames = new Set(ports.map((port) => port.name));
    push('Signals', uniqueChildren(contents.signals).filter((signal) => !portNames.has(signal.name)));
    return groups;
}

function uniqueChildren(children?: ClassifiedChild[]): ClassifiedChild[] {
    const names = new Set<string>();
    return (children ?? []).filter((child) => {
        if (!child || !child.name || names.has(child.name)) {
            return false;
        }
        names.add(child.name);
        return true;
    });
}

function hasPortDirection(port: ClassifiedChild): boolean {
    const detail = port.detail?.toLowerCase() ?? '';
    return detail.startsWith('input') || detail.startsWith('output') || detail.startsWith('inout');
}

/**
 * Groups Object-kind workspace symbols by their container name, so instance
 * names can be attached to their owning module when document symbols carry no
 * instance children (llg indexes instances but keeps them out of
 * module_children). Names WITHOUT instantiated types - never guessed.
 */
function groupInstanceNamesByContainer(
    symbols: readonly vscode.SymbolInformation[],
    budget: SnapshotNormalizationBudget,
): Map<string, string[]> {
    const byScope = new Map<string, Set<string>>();
    const limit = Math.min(symbols.length, MAX_SNAPSHOT_NORMALIZATION_ITEMS);
    if (symbols.length > limit) {
        noteSnapshotTruncation(budget);
    }
    let indexedNames = 0;
    for (let index = 0; index < limit; index += 1) {
        const symbol = symbols[index];
        if (!symbol || !isInstanceKind(symbol.kind) || !symbol.containerName) {
            continue;
        }
        let names = byScope.get(symbol.containerName);
        if (!names) {
            if (indexedNames >= MAX_SNAPSHOT_NORMALIZATION_ITEMS) {
                noteSnapshotTruncation(budget);
                break;
            }
            names = new Set<string>();
            byScope.set(symbol.containerName, names);
        }
        if (!names.has(symbol.name)) {
            if (indexedNames >= MAX_SNAPSHOT_NORMALIZATION_ITEMS) {
                noteSnapshotTruncation(budget);
                break;
            }
            names.add(symbol.name);
            indexedNames += 1;
        }
    }
    const sorted = new Map<string, string[]>();
    for (const [scope, names] of byScope) {
        const values: string[] = [];
        for (const name of names) {
            values.push(name);
        }
        values.sort();
        sorted.set(scope, values);
    }
    return sorted;
}

// vscode DocumentSymbol/SymbolInformation kinds are the LSP numbering minus
// one (@types/vscode File = 0 vs LSP File = 1), so +1 recovers the wire
// values the pure classifier expects - same trick as ModuleInstantiation.ts.
function toWireChild(child: vscode.DocumentSymbol, uriString: string): RawSymbolChild {
    return {
        name: child.name,
        kind: child.kind + 1,
        detail: child.detail,
        uri: uriString,
        // Contents navigation targets the identifier declaration range. The
        // full symbol range remains the compatibility fallback for providers
        // that do not populate selectionRange.
        range: toSourceRange(child.selectionRange ?? child.range),
    };
}

function toSourceRange(range: vscode.Range | undefined): SourceRange | undefined {
    return range
        ? {
              startLine: range.start.line,
              startCharacter: range.start.character,
              endLine: range.end.line,
              endCharacter: range.end.character,
          }
        : undefined;
}

interface BoundedWireChildren {
    children: RawSymbolChild[];
    truncated: boolean;
}

function boundedWireChildren(
    children: readonly vscode.DocumentSymbol[],
    uriString: string,
    budget: SnapshotNormalizationBudget,
): BoundedWireChildren {
    if (children.length === 0) {
        return { children: [], truncated: false };
    }
    let limit = Math.min(children.length, availableSnapshotDataSlots(budget));
    if (limit < children.length) {
        noteSnapshotTruncation(budget);
        limit = Math.min(children.length, availableSnapshotDataSlots(budget));
    }
    const bounded: RawSymbolChild[] = [];
    for (let index = 0; index < limit; index += 1) {
        bounded.push(toWireChild(children[index], uriString));
    }
    return { children: bounded, truncated: limit < children.length };
}

function takeBoundedItems<T>(items: readonly T[], budget: SnapshotNormalizationBudget): T[] {
    const bounded: T[] = [];
    for (let index = 0; index < items.length; index += 1) {
        if (!takeSnapshotDataSlot(budget)) {
            break;
        }
        bounded.push(items[index]);
    }
    return bounded;
}

function toModuleRecord(
    symbol: vscode.DocumentSymbol,
    uriString: string,
    instanceNamesByScope: Map<string, string[]>,
    budget: SnapshotNormalizationBudget,
): ModuleRecord | undefined {
    if (!takeSnapshotDataSlot(budget)) {
        return undefined;
    }
    const boundedChildren = boundedWireChildren(symbol.children ?? [], uriString, budget);
    const classified = classifyDocumentSymbolChildren(boundedChildren.children);
    const ports = takeBoundedItems(classified.ports, budget);
    const params = takeBoundedItems(classified.params, budget);
    const signals = takeBoundedItems(classified.signals, budget);
    let instances = takeBoundedItems(classified.instances, budget);
    // Server-shaped instance children (Object kind, detail = module type)
    // carry the hierarchy edges; the workspace-symbol container-name fallback
    // only fills in when a server emits none of them.
    if (classified.instances.length === 0 && !boundedChildren.truncated) {
        const fallbackNames = instanceNamesByScope.get(symbol.name) ?? [];
        const boundedFallbackNames: string[] = [];
        for (let index = 0; index < fallbackNames.length; index += 1) {
            if (!takeSnapshotDataSlot(budget)) {
                break;
            }
            boundedFallbackNames.push(fallbackNames[index]);
        }
        instances = applyInstanceNameFallback([], boundedFallbackNames);
    }
    return {
        name: symbol.name,
        uri: uriString,
        range: toSourceRange(symbol.range),
        ports,
        params,
        signals,
        instances,
    };
}

function collectModuleRecords(
    symbols: readonly vscode.DocumentSymbol[],
    uriString: string,
    instanceNamesByScope: Map<string, string[]>,
    seen: Set<string>,
    out: ModuleRecord[],
    budget: SnapshotNormalizationBudget,
): void {
    interface SymbolFrame {
        symbols: readonly vscode.DocumentSymbol[];
        nextIndex: number;
    }
    const stack: SymbolFrame[] = [{ symbols, nextIndex: 0 }];
    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.nextIndex >= frame.symbols.length) {
            stack.pop();
            continue;
        }
        const symbol = frame.symbols[frame.nextIndex];
        frame.nextIndex += 1;
        if (!symbol) {
            continue;
        }

        const moduleSymbol = isModuleKind(symbol.kind);
        if (moduleSymbol) {
            // Dedupe nested walks and per-file re-queries positionally.
            const selection = symbol.selectionRange ?? symbol.range;
            const key = `${uriString}|${symbol.name}|${selection?.start.line ?? -1}:${selection?.start.character ?? -1}`;
            if (!seen.has(key)) {
                const record = toModuleRecord(symbol, uriString, instanceNamesByScope, budget);
                if (!record) {
                    break;
                }
                seen.add(key);
                out.push(record);
            } else if (!takeSnapshotDataSlot(budget)) {
                break;
            }
        } else if (!takeSnapshotDataSlot(budget)) {
            break;
        }

        const children = symbol.children ?? [];
        if (children.length > 0) {
            if (availableSnapshotDataSlots(budget) <= 0) {
                noteSnapshotTruncation(budget);
                break;
            }
            stack.push({ symbols: children, nextIndex: 0 });
        }
    }
}

async function collectWorkspaceModules(
    log: Logger,
    budget: SnapshotNormalizationBudget,
): Promise<ModuleRecord[]> {
    const symbols =
        (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            WORKSPACE_SYMBOLS_COMMAND,
            WORKSPACE_SYMBOL_QUERY,
        )) ?? [];
    const symbolLimit = Math.min(symbols.length, MAX_SNAPSHOT_NORMALIZATION_ITEMS);
    if (symbols.length > symbolLimit) {
        // The workspace-symbol response is only an index for the document
        // queries below. Keep the scan itself bounded and expose an omitted
        // suffix through the same response marker as normalized snapshots.
        noteSnapshotTruncation(budget);
    }

    const instanceNamesByScope = groupInstanceNamesByContainer(symbols, budget);

    const uris: string[] = [];
    const seenUris = new Set<string>();
    for (let index = 0; index < symbolLimit; index += 1) {
        const hit = symbols[index];
        if (!hit || !isModuleKind(hit.kind)) {
            continue;
        }
        const key = hit.location.uri.toString();
        if (!seenUris.has(key)) {
            if (uris.length >= MAX_DOCUMENT_SYMBOL_FILES) {
                noteSnapshotTruncation(budget);
                break;
            }
            seenUris.add(key);
            uris.push(key);
        }
    }

    const records: ModuleRecord[] = [];
    const seenModules = new Set<string>();
    for (const uriString of uris) {
        if (availableSnapshotDataSlots(budget) <= 0) {
            noteSnapshotTruncation(budget);
            break;
        }
        let docSymbols: vscode.DocumentSymbol[] | undefined;
        try {
            docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                DOCUMENT_SYMBOLS_COMMAND,
                vscode.Uri.parse(uriString),
            );
        } catch (error) {
            log.warn(`document symbols unavailable for ${uriString}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        collectModuleRecords(docSymbols ?? [], uriString, instanceNamesByScope, seenModules, records, budget);
        if (availableSnapshotDataSlots(budget) <= 0) {
            noteSnapshotTruncation(budget);
            break;
        }
    }
    // Deterministic input order for buildHierarchy's first-record-wins dedupe.
    return records.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0,
    );
}

function legacyRootFromRecord(record: ModuleRecord): HierarchyRoot {
    return {
        ...(record.id ? { id: record.id } : {}),
        name: record.name,
        ...(record.uri ? { uri: record.uri } : {}),
        ...(record.range ? { range: record.range } : {}),
        ...(record.ports !== undefined ? { ports: record.ports } : {}),
        ...(record.params !== undefined ? { params: record.params } : {}),
        ...(record.signals !== undefined ? { signals: record.signals } : {}),
        contentSource: record.contentSource ?? 'declaration',
        ...(record.isAmbiguousDefinition ? { isAmbiguousDefinition: true } : {}),
        children: [],
    };
}

export function fallbackRootsFromRecords(
    records: readonly ModuleRecord[],
    budget: SnapshotNormalizationBudget,
): HierarchyRoot[] {
    const roots: HierarchyRoot[] = [];
    for (const record of records) {
        const bounded = boundLegacyHierarchy([legacyRootFromRecord(record)], budget);
        if (bounded.length === 0) {
            break;
        }
        roots.push(bounded[0]);
    }
    if (budget.truncated && !budget.markerAttached && roots.length > 0) {
        (roots[roots.length - 1] as HierarchyRoot & { isBudgetTruncated?: boolean }).isBudgetTruncated = true;
        budget.markerAttached = true;
    }
    return roots;
}

export interface ExplorerData {
    records: ModuleRecord[];
    roots: HierarchyRoot[];
    isBudgetTruncated?: boolean;
}

export async function collectExplorerData(
    manager: LlgClientManager | undefined,
    log: Logger,
): Promise<ExplorerData> {
    if (manager) {
        try {
            const snapshot = await manager.getModuleExplorerSnapshot();
            if (snapshot !== undefined) {
                const normalized = normalizeModuleExplorerSnapshot(snapshot);
                if (normalized !== undefined) {
                    return normalized;
                }
                log.warn('llg returned a malformed module explorer snapshot; using symbol fallback');
            }
        } catch (error) {
            // A server can be starting, stopping, or be an older external
            // executable. The symbol path remains useful in all of these
            // cases and the next scheduled refresh can retry the snapshot.
            log.debug(`module explorer snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const budget = createSnapshotNormalizationBudget(1);
    const records = await collectWorkspaceModules(log, budget);
    const hierarchyBudget: HierarchyBuildBudget = {
        takeRootSlot: () => takeSnapshotRootSlot(budget),
        takeNodeSlot: () => takeSnapshotDataSlot(budget),
        takeContentSlot: () => takeSnapshotDataSlot(budget),
        noteTruncation: () => noteSnapshotTruncation(budget),
        markTruncationAttached: () => {
            budget.markerAttached = true;
        },
    };
    let roots = buildHierarchy(records, hierarchyBudget);
    if (budget.truncated && !budget.markerAttached && roots.length > 0) {
        roots[roots.length - 1].isBudgetTruncated = true;
        budget.markerAttached = true;
    }
    if (roots.length === 0 && records.length > 0) {
        // Keep declaration-only definitions visible when the legacy hierarchy
        // builder has no ordinary root. This uses the same budget, so the
        // promoted prefix cannot duplicate an unbounded module catalog.
        roots = fallbackRootsFromRecords(records, budget);
    }
    releaseSnapshotReservedSlots(budget);
    return {
        records,
        roots,
        ...(budget.truncated ? { isBudgetTruncated: true } : {}),
    };
}

function moduleSelectionOf(item?: HierarchyItem): string | undefined {
    return item?.id;
}

function targetLocation(target: unknown): { uri?: string; range?: SourceRange } {
    if (!target || typeof target !== 'object') {
        return {};
    }
    const item = target as Partial<HierarchyItem>;
    if ('root' in item && item.root) {
        return { uri: item.root.uri, range: item.root.range };
    }
    if ('node' in item && item.node) {
        return { uri: item.node.uri, range: item.node.range };
    }
    const location = item as {
        uri?: unknown;
        range?: unknown;
        location?: unknown;
        declarationLocation?: unknown;
    };
    const directUri = typeof location.uri === 'string' ? location.uri : undefined;
    const directRange = isSourceRange(location.range) ? location.range : undefined;
    if (directUri) {
        return { uri: directUri, range: directRange };
    }
    for (const candidate of [location.location, location.declarationLocation]) {
        if (!candidate || typeof candidate !== 'object') {
            continue;
        }
        const nested = candidate as { uri?: unknown; range?: unknown };
        if (typeof nested.uri === 'string') {
            return {
                uri: nested.uri,
                range: isSourceRange(nested.range) ? nested.range : undefined,
            };
        }
    }
    return {};
}

function isSourceRange(value: unknown): value is SourceRange {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const range = value as Partial<SourceRange>;
    return typeof range.startLine === 'number' && typeof range.startCharacter === 'number' &&
        typeof range.endLine === 'number' && typeof range.endCharacter === 'number';
}

/**
 * Registers the HDL Modules explorer: both tree views, their commands and the
 * debounced auto-refresh listeners. Every disposable lands in
 * context.subscriptions.
 */
export function registerModuleExplorer(
    context: vscode.ExtensionContext,
    log: Logger,
    manager?: LlgClientManager,
): ModuleExplorerTestAdapter | undefined {
    const state: ExplorerState = { records: [], roots: [], ambiguousNames: new Set<string>() };
    const hierarchyProvider = new ModuleHierarchyProvider(state);
    const contentsProvider = new ModuleContentsProvider(state);
    let disposed = false;
    let refreshInFlight: Promise<void> | undefined;

    const controller: ModuleExplorerController = {
        async refresh(): Promise<void> {
            if (disposed) {
                return;
            }
            if (refreshInFlight !== undefined) {
                return refreshInFlight;
            }
            const operation = (async (): Promise<void> => {
                const data = await collectExplorerData(manager, log);
                if (disposed) {
                    return;
                }
                state.records = data.records;
                state.roots = data.roots;
                const selected = state.selectedHierarchyId;
                if (selected && !findHierarchyItem(state.roots, selected)) {
                    // Selection is tied to the exact hierarchy occurrence,
                    // not merely its module definition. Keep it across a
                    // refresh when the server preserves that stable node ID.
                    state.selectedHierarchyId = undefined;
                }
                state.ambiguousNames = ambiguousModuleNames(data.records);
                hierarchyProvider.fire();
                contentsProvider.fire();
            })();
            const tracked = operation.finally(() => {
                if (refreshInFlight === tracked) {
                    refreshInFlight = undefined;
                }
            });
            refreshInFlight = tracked;
            return tracked;
        },
        async reveal(target: unknown): Promise<void> {
            if (disposed) {
                return;
            }
            const location = targetLocation(target);
            if (!location.uri) {
                void vscode.window.showInformationMessage('HDL-Support: this entry has no known source location');
                return;
            }
            const options: vscode.TextDocumentShowOptions = { preview: true };
            if (location.range) {
                options.selection = new vscode.Range(
                    location.range.startLine,
                    location.range.startCharacter,
                    location.range.endLine,
                    location.range.endCharacter,
                );
            }
            await vscode.window.showTextDocument(vscode.Uri.parse(location.uri), options);
        },
    };

    const hierarchyView = vscode.window.createTreeView(HIERARCHY_VIEW_ID, {
        treeDataProvider: hierarchyProvider,
        showCollapseAll: true,
    });
    const contentsView = vscode.window.createTreeView(CONTENTS_VIEW_ID, {
        treeDataProvider: contentsProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(hierarchyView, contentsView, hierarchyProvider, contentsProvider);

    const selectHierarchyItem = (item?: HierarchyItem): void => {
        if (disposed) {
            return;
        }
        state.selectedHierarchyId = moduleSelectionOf(item);
        contentsProvider.fire();
    };

    hierarchyView.onDidChangeSelection(
        (event) => {
            selectHierarchyItem(event.selection[0]);
        },
        null,
        context.subscriptions,
    );

    // Refresh policy (see refreshScheduler.ts): didOpen/didSave bursts
    // collapse into ONE debounced sweep, and a running sweep is never
    // overlapped — triggers landing mid-sweep arm exactly one follow-up that
    // observes the latest provider state.
    const refreshScheduler = new RefreshScheduler();
    let debounceTimer: NodeJS.Timeout | undefined;
    const armRefreshTimer = (): void => {
        if (disposed) {
            return;
        }
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            if (disposed) {
                return;
            }
            void runScheduledRefresh();
        }, REFRESH_DEBOUNCE_MS);
    };
    const runScheduledRefresh = (): Promise<void> => {
        if (disposed) {
            return Promise.resolve();
        }
        if (!refreshScheduler.begin()) {
            return Promise.resolve();
        }
        return controller.refresh()
            .catch((error) => {
                log.error(`refreshing the HDL module hierarchy failed: ${error instanceof Error ? error.message : String(error)}`);
            })
            .then(() => {
                const completion = refreshScheduler.complete();
                if (!disposed && completion === 'reschedule') {
                    armRefreshTimer();
                }
            });
    };
    const scheduleRefresh = (): void => {
        if (refreshScheduler.request() === 'arm') {
            armRefreshTimer();
        }
    };
    const isHdlDocument = (document: vscode.TextDocument): boolean =>
        HDL_LANGUAGE_IDS.includes(document.languageId.toLowerCase());
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (isHdlDocument(document)) {
                scheduleRefresh();
            }
        }),
        vscode.workspace.onDidOpenTextDocument((document) => {
            if (isHdlDocument(document)) {
                scheduleRefresh();
            }
        }),
        ...(manager
            ? [manager.onModuleExplorerChanged(() => {
                if (!disposed) {
                    scheduleRefresh();
                }
            })]
            : []),
        {
            dispose: () => {
                disposed = true;
                refreshScheduler.cancelPending();
                clearTimeout(debounceTimer);
                debounceTimer = undefined;
            },
        },
    );

    registerModuleExplorerCommands(context, controller);

    // Fill the views without blocking activation, through the same coalescing
    // policy so a concurrent trigger cannot double-sweep; failures surface
    // through log only.
    // Seed the scheduler's Pending state for the activation-time sweep. A
    // direct begin() is intentionally rejected by RefreshScheduler while
    // idle, so the initial run must enter through the same request seam as
    // file-event refreshes.
    refreshScheduler.request();
    void runScheduledRefresh();

    if (process.env.HDLSUPPORT_E2E_EXPLORER !== '1') {
        return undefined;
    }

    const waitForIdle = async (): Promise<void> => {
        // Include a pending debounce window so host tests can wait for the
        // same refresh path used by file/server notifications.
        while (refreshInFlight !== undefined || debounceTimer !== undefined) {
            if (refreshInFlight !== undefined) {
                await refreshInFlight;
                continue;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, REFRESH_DEBOUNCE_MS + 1));
        }
    };

    const selectTestHierarchyNode = async (id: string): Promise<void> => {
        const item = findHierarchyItem(state.roots, id);
        if (!item) {
            throw new Error(`HDL module hierarchy item not found: ${id}`);
        }
        selectHierarchyItem(item);
    };

    const adapter: ModuleExplorerTestAdapter = {
        wait: waitForIdle,
        inspect: (): ModuleExplorerTestInspection => ({
            hierarchy: inspectProviderTree(hierarchyProvider),
            contents: inspectProviderTree(contentsProvider),
            ...(state.selectedHierarchyId ? { selectedId: state.selectedHierarchyId } : {}),
        }),
        select: selectTestHierarchyNode,
        waitForRefresh: async (_timeoutMs?: number): Promise<void> => waitForIdle(),
        getHierarchyTreeItems: async (): Promise<readonly ModuleExplorerTestTreeItem[]> => {
            await waitForIdle();
            return adapter.inspect().hierarchy;
        },
        selectHierarchyNode: selectTestHierarchyNode,
        getModuleContentsTreeItems: async (): Promise<readonly ModuleExplorerTestTreeItem[]> => {
            await waitForIdle();
            return adapter.inspect().contents;
        },
    };
    return adapter;
}
