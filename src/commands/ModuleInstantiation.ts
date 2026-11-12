// SPDX-License-Identifier: MIT
import * as path from 'path';
import {
    buildModuleQuickPickItems,
    cleanDisplayPath,
    isModuleSymbolKind,
    WorkspaceModuleRef,
} from '../hierarchy/moduleHierarchy';

// The VS Code API is loaded lazily (on first command execution) instead of via a
// top-level import, so the pure helpers exported below stay loadable - and
// unit-testable - in plain Node without the extension host.
type VscodeApi = typeof import('vscode');
type Uri = import('vscode').Uri;
type DocumentSymbol = import('vscode').DocumentSymbol;
type SymbolInformation = import('vscode').SymbolInformation;

let vscodeApi: VscodeApi | undefined;

function getVscode(): VscodeApi {
    if (!vscodeApi) {
        vscodeApi = require('vscode') as VscodeApi;
    }
    return vscodeApi;
}

export interface PortOrParam {
    name: string;
    detail?: string;
    isParameter: boolean;
}

/** Minimal logger surface injected by the caller (see extension.ts). */
export interface CommandLogger {
    info(message: string): void;
    error(message: string): void;
}

// LSP SymbolKind numbers as emitted on the wire by llg document symbols
// (lapligence/src/bin/llg_ls/features.rs, sym_kind_to_lsp): modules are Module (2),
// ports Property (7), nets/variables Variable (13), parameters Constant (14).
const LSP_SYMBOL_KIND_CONSTANT = 14;
// Instance children (Object, 19) carry the instantiated module type in their
// detail; they are hierarchy edges, not port connections.
const LSP_SYMBOL_KIND_OBJECT = 19;
// llg renders parameter details like "parameter int WIDTH = 8" or
// "localparam int DEPTH = 4" (features.rs format_param), so those prefixes
// identify parameters even when a server picks an unexpected symbol kind.
const PARAMETER_DETAIL_PREFIXES = ['parameter', 'localparam'];

/**
 * Splits the children of a module document symbol into port connections and
 * parameter overrides. `kind` is the raw LSP SymbolKind number. Parameters are
 * recognized by kind Constant or by their detail text; Object-kind (19)
 * instance children are skipped (they describe instantiations, not ports);
 * every other child (unknown kinds included) defaults to a port connection.
 */
export function classifyModuleChildren(
    children: Array<{ name: string; kind: number; detail?: string }>
): PortOrParam[] {
    const result: PortOrParam[] = [];
    for (const child of children ?? []) {
        if (!child || !child.name) {
            continue;
        }
        if (child.kind === LSP_SYMBOL_KIND_OBJECT) {
            continue;
        }
        const detail = typeof child.detail === 'string' ? child.detail : undefined;
        const isParameter =
            child.kind === LSP_SYMBOL_KIND_CONSTANT ||
            PARAMETER_DETAIL_PREFIXES.some((prefix) => detail !== undefined && detail.startsWith(prefix));
        result.push({ name: child.name, detail, isParameter });
    }
    return result;
}

const CONNECTION_INDENT = '    ';

// Renders ".NAME(NAME)" connection lines aligned like the legacy generator,
// including its trailing-space padding before the parentheses.
function formatConnections(names: string[]): string {
    let maxLen = 0;
    for (const name of names) {
        if (name.length > maxLen) {
            maxLen = name.length;
        }
    }
    let out = '';
    for (let i = 0; i < names.length; i++) {
        const padded = names[i] + ' '.repeat(maxLen - names[i].length + 1);
        out += CONNECTION_INDENT + `.${padded}(${padded})`;
        if (i !== names.length - 1) {
            out += ',';
        }
        out += '\n';
    }
    return out;
}

/**
 * Builds the instantiation snippet text for one module. Tabstop $1 is the
 * instance name, and tabstop $2 covers the opening parenthesis and newline
 * before the port list.
 */
export function buildInstantiationSnippet(
    moduleName: string,
    instanceName: string,
    portsAndParams: PortOrParam[]
): string {
    const params = portsAndParams.filter((p) => p.isParameter).map((p) => p.name);
    const ports = portsAndParams.filter((p) => !p.isParameter).map((p) => p.name);
    const paramString = params.length > 0 ? `#(\n${formatConnections(params)})\n` : '';
    return (
        `${moduleName} ` +
        paramString +
        `\${1:${instanceName}}` +
        `\${2:(\n}` +
        formatConnections(ports) +
        ');\n'
    );
}

/** Plain-data cursor position (zero-based), independent of the vscode API. */
export interface SnapshotPosition {
    line: number;
    character: number;
}

/**
 * Immutable description of the editor that must receive an instantiation,
 * captured BEFORE any module enumeration or document loading starts. Plain
 * data only, so the downstream insertion decision is unit-testable without
 * vscode.
 */
export interface DestinationSnapshot {
    /** Stringified uri of the destination document. */
    uri: string;
    /** Document version at capture time (diagnostic information only). */
    version: number | undefined;
    /** Selection anchor at capture time (equals active for a bare cursor). */
    anchor: SnapshotPosition;
    /** Cursor position at capture time; the snippet lands here. */
    active: SnapshotPosition;
}

/**
 * Liveness of the captured destination, re-observed right before the edit is
 * applied. Deliberately describes ONLY the captured uri - there is no field
 * for the "current" active editor, so any focus change that happened while
 * modules were being enumerated cannot influence the insertion decision.
 */
export interface DestinationObservation {
    /** A visible editor still shows the destination document. */
    editorVisible: boolean;
    /** The destination document is still open in the workspace. */
    documentOpen: boolean;
}

export type InsertionPlan =
    | {
          outcome: 'insert';
          /** Destination uri the snippet must go to (the captured one). */
          uri: string;
          anchor: SnapshotPosition;
          active: SnapshotPosition;
      }
    | { outcome: 'destinationClosed'; uri: string };

/**
 * Decides where - and whether - the instantiation snippet is inserted, from
 * the pre-capture snapshot plus a destination-only liveness observation. The
 * plan freezes the cursor captured before module loading started; later
 * active-editor changes are not part of the inputs and cannot redirect the
 * insertion into another file.
 */
export function planInsertion(
    snapshot: DestinationSnapshot,
    observation: DestinationObservation | undefined
): InsertionPlan {
    if (!observation || !observation.editorVisible || !observation.documentOpen) {
        return { outcome: 'destinationClosed', uri: snapshot.uri };
    }
    return {
        outcome: 'insert',
        uri: snapshot.uri,
        anchor: snapshot.anchor,
        active: snapshot.active,
    };
}

const INSTANCE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const SOURCE_GLOB = '{**/*.v,**/*.sv}';
const EXCLUDE_GLOB = '**/{node_modules,target}/**';
const MAX_SOURCE_FILES = 200;
// Same enumeration the HDL Modules explorer uses: '' substring-matches every
// declaration in llg workspace_symbols, and other providers commonly accept
// empty queries gracefully.
const WORKSPACE_SYMBOLS_COMMAND = 'vscode.executeWorkspaceSymbolProvider';
const WORKSPACE_SYMBOL_QUERY = '';
const DOCUMENT_SYMBOLS_COMMAND = 'vscode.executeDocumentSymbolProvider';

function defaultLogger(): CommandLogger {
    return {
        info: (message) => console.log(`[ModuleInstantiation] ${message}`),
        error: (message) => console.error(`[ModuleInstantiation] ${message}`),
    };
}

// registerCommand forwards invocation arguments, so anything that does not
// look like a logger falls back to the console-based default.
function resolveLogger(candidate?: unknown): CommandLogger {
    if (
        candidate &&
        typeof candidate === 'object' &&
        typeof (candidate as CommandLogger).info === 'function' &&
        typeof (candidate as CommandLogger).error === 'function'
    ) {
        return candidate as CommandLogger;
    }
    return defaultLogger();
}

function isHdlLanguage(languageId: string): boolean {
    const id = languageId.toLowerCase();
    return id === 'verilog' || id === 'systemverilog';
}

async function selectSourceUri(log: CommandLogger): Promise<Uri | undefined> {
    const vsc = getVscode();
    const active = vsc.window.activeTextEditor;
    if (active && isHdlLanguage(active.document.languageId)) {
        log.info(`using active editor ${active.document.fileName}`);
        return active.document.uri;
    }
    const files = await vsc.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB, MAX_SOURCE_FILES);
    if (files.length === 0) {
        vsc.window.showInformationMessage('HDL-Support: no Verilog/SystemVerilog files found in the workspace');
        return undefined;
    }
    const items = files.map((uri) => ({
        label: path.basename(uri.fsPath),
        description: uri.fsPath,
        uri,
    }));
    const picked = await vsc.window.showQuickPick(items, { placeHolder: 'Choose the module file' });
    return picked?.uri;
}

/** Outcome of the workspace-wide module pick. */
type WorkspaceSelection =
    | { outcome: 'picked'; module: WorkspaceModuleRef }
    | { outcome: 'cancelled' }
    // No workspace folder open, or the providers surfaced no modules at all:
    // the caller falls back to the single-document flow.
    | { outcome: 'unavailable' };

/**
 * Enumerates EVERY Verilog/SystemVerilog module in the workspace through the
 * registered workspace symbol provider and lets the user pick one from a
 * quick-pick whose entries carry the defining file's workspace-relative path.
 */
async function selectWorkspaceModule(log: CommandLogger): Promise<WorkspaceSelection> {
    const vsc = getVscode();
    if ((vsc.workspace.workspaceFolders ?? []).length === 0) {
        return { outcome: 'unavailable' };
    }

    let symbols: SymbolInformation[];
    try {
        symbols =
            (await vsc.commands.executeCommand<SymbolInformation[]>(
                WORKSPACE_SYMBOLS_COMMAND,
                WORKSPACE_SYMBOL_QUERY
            )) ?? [];
    } catch (e) {
        log.error(`workspace symbol enumeration failed: ${String(e)}`);
        return { outcome: 'unavailable' };
    }

    const moduleRefs: WorkspaceModuleRef[] = symbols
        .filter((symbol) => symbol && isModuleSymbolKind(symbol.kind))
        .map((symbol) => ({ name: symbol.name, uri: symbol.location.uri.toString() }));
    if (moduleRefs.length === 0) {
        return { outcome: 'unavailable' };
    }

    const items = buildModuleQuickPickItems(moduleRefs, (uri) =>
        cleanDisplayPath(vsc.workspace.asRelativePath(vsc.Uri.parse(uri)))
    );
    const picked = await vsc.window.showQuickPick(items, {
        placeHolder: 'Choose a module to instantiate',
        matchOnDetail: true,
    });
    if (!picked) {
        return { outcome: 'cancelled' };
    }
    return { outcome: 'picked', module: { name: picked.name, uri: picked.uri } };
}

function findModuleSymbols(symbols: DocumentSymbol[]): DocumentSymbol[] {
    const vsc = getVscode();
    const modules = symbols.filter((symbol) => symbol.kind === vsc.SymbolKind.Module);
    if (modules.length > 0) {
        return modules;
    }
    // Fallback for servers that do not emit SymbolKind.Module: accept any
    // top-level symbol whose children classify into both ports and parameters.
    return symbols.filter((symbol) => {
        const classified = classifyModuleChildren(toLspChildren(symbol.children));
        return (
            classified.length > 0 &&
            classified.some((c) => c.isParameter) &&
            classified.some((c) => !c.isParameter)
        );
    });
}

// VS Code's SymbolKind enum numbering is the LSP numbering minus one
// (@types/vscode: File = 0 vs LSP File = 1), so shifting by one recovers the
// wire values the pure classifier expects.
function toLspChildren(children: Array<{ name: string; kind: number; detail?: string }>): Array<{ name: string; kind: number; detail?: string }> {
    return children.map((child) => ({ name: child.name, kind: child.kind + 1, detail: child.detail }));
}

async function chooseModule(modules: DocumentSymbol[]): Promise<DocumentSymbol | undefined> {
    if (modules.length === 1) {
        return modules[0];
    }
    const pickedName = await getVscode().window.showQuickPick(modules.map((m) => m.name), {
        placeHolder: 'Choose a module to instantiate',
    });
    return pickedName ? modules.find((m) => m.name === pickedName) : undefined;
}

// Freezes the insertion destination at the moment the command starts, before
// any quick pick, input box or document loading can change the window state.
function captureDestinationSnapshot(): DestinationSnapshot | undefined {
    const vsc = getVscode();
    const editor = vsc.window.activeTextEditor;
    if (!editor) {
        return undefined;
    }
    return {
        uri: editor.document.uri.toString(),
        version: editor.document.version,
        anchor: { line: editor.selection.anchor.line, character: editor.selection.anchor.character },
        active: { line: editor.selection.active.line, character: editor.selection.active.character },
    };
}

// Observes ONLY the captured destination (never the global active editor), so
// documents opened while enumerating module symbols stay irrelevant.
function observeDestination(snapshot: DestinationSnapshot): DestinationObservation {
    const vsc = getVscode();
    return {
        editorVisible: vsc.window.visibleTextEditors.some(
            (editor) => editor.document.uri.toString() === snapshot.uri
        ),
        documentOpen: vsc.workspace.textDocuments.some(
            (document) => document.uri.toString() === snapshot.uri
        ),
    };
}

/**
 * Applies the snippet strictly to the pre-captured destination through
 * workspace.applyEdit with a SnippetTextEdit instead of TextEditor.insertSnippet:
 *
 * - the edit targets the CAPTURED document uri, so no editor lookup can reroute
 *   it into a document that was opened during module loading;
 * - a workspace edit bumps the document version, which guarantees a
 *   textDocument/didChange to llg - the server stages semantic tokens for
 *   opened files from exactly that in-memory buffer, so the inserted text is
 *   highlighted immediately. The old path applied an editor-level snippet edit
 *   to a document showTextDocument had just focused (sometimes a background
 *   tile, sometimes not even the file being looked at), which left the rendered
 *   tokens stale until some later document event;
 * - there is no public client-side semantic-tokens refresh trigger (the
 *   workspace/semanticTokens/refresh request flows server->client only and is
 *   handled inside vscode-languageclient), so the guaranteed didChange is the
 *   most reliable refresh mechanism available.
 *
 * Because nothing in this flow ever calls showTextDocument, the user's editor
 * keeps focus throughout and the snippet tabstops start right where the user
 * was typing.
 */
async function applyInstantiationEdit(
    snapshot: DestinationSnapshot,
    snippetText: string,
    log: CommandLogger
): Promise<void> {
    const vsc = getVscode();
    const plan = planInsertion(snapshot, observeDestination(snapshot));
    if (plan.outcome !== 'insert') {
        log.error(`refusing to insert: destination ${plan.uri} was closed`);
        vsc.window.showErrorMessage(
            'HDL-Support: the destination editor was closed before the instantiation could be inserted'
        );
        return;
    }
    log.info(
        `inserting into ${plan.uri} ` +
            `(captured at version ${snapshot.version}, cursor ${snapshot.active.line}:${snapshot.active.character})`
    );
    const uri = vsc.Uri.parse(plan.uri);
    const anchor = new vsc.Position(plan.anchor.line, plan.anchor.character);
    const active = new vsc.Position(plan.active.line, plan.active.character);
    const snippet = new vsc.SnippetString(snippetText);
    // A bare cursor inserts at the frozen position; a captured non-empty
    // selection is replaced by the snippet, matching the previous behavior.
    const snippetEdit =
        anchor.isEqual(active)
            ? vsc.SnippetTextEdit.insert(active, snippet)
            : vsc.SnippetTextEdit.replace(new vsc.Range(anchor, active), snippet);
    const edit = new vsc.WorkspaceEdit();
    edit.set(uri, [snippetEdit]);
    const applied = await vsc.workspace.applyEdit(edit);
    if (!applied) {
        log.error(`applying the instantiation edit to ${plan.uri} failed`);
        vsc.window.showErrorMessage('HDL-Support: failed to insert the instantiation');
    }
}

/**
 * Reads a document's hierarchical document symbols from the language server
 * and reduces them to module definitions. Returns undefined (with a user-facing
 * message already shown) when symbols are unavailable or contain no modules.
 */
async function loadModuleSymbols(uri: Uri, log: CommandLogger): Promise<DocumentSymbol[] | undefined> {
    const vsc = getVscode();
    let symbols: DocumentSymbol[] | undefined;
    try {
        symbols = await vsc.commands.executeCommand<DocumentSymbol[]>(
            DOCUMENT_SYMBOLS_COMMAND,
            uri
        );
    } catch (e) {
        log.error(String(e));
        vsc.window.showInformationMessage('HDL-Support: error retrieving document symbols');
        return undefined;
    }
    if (!symbols || symbols.length === 0) {
        vsc.window.showErrorMessage('Verilog-HDL/SystemVerilog: No modules found in the file');
        return undefined;
    }

    const modules = findModuleSymbols(symbols);
    if (modules.length === 0) {
        vsc.window.showErrorMessage('Verilog-HDL/SystemVerilog: No modules found in the file');
        return undefined;
    }
    return modules;
}

/**
 * Classifies the chosen module's ports/parameters, asks for an instance name
 * and applies the instantiation snippet to the PRE-CAPTURED destination.
 */
async function insertInstantiation(
    chosenModule: DocumentSymbol,
    snapshot: DestinationSnapshot,
    log: CommandLogger
): Promise<void> {
    const vsc = getVscode();
    const portsAndParams = classifyModuleChildren(toLspChildren(chosenModule.children));
    log.info(
        `module ${chosenModule.name}: ` +
            `${portsAndParams.filter((p) => p.isParameter).length} parameter(s), ` +
            `${portsAndParams.filter((p) => !p.isParameter).length} port(s)`
    );

    const instanceName = await vsc.window.showInputBox({
        prompt: `Instance name for module '${chosenModule.name}'`,
        placeHolder: `${chosenModule.name}_i`,
        validateInput: (value) =>
            INSTANCE_NAME_PATTERN.test(value) ? undefined : 'Not a valid Verilog/SystemVerilog identifier',
    });
    if (!instanceName) {
        return;
    }

    const snippetText = buildInstantiationSnippet(chosenModule.name, instanceName, portsAndParams);
    await applyInstantiationEdit(snapshot, snippetText, log);
}

/**
 * Command entry point for `verilog.instantiateModule`: list every Verilog/
 * SystemVerilog module in the workspace (falling back to the active editor's
 * or a picked file's modules when no workspace modules can be enumerated),
 * let the user choose a module and instance name, then insert the
 * instantiation snippet at the cursor of the editor that was active when the
 * command started. The destination is snapshotted up front and module symbols
 * are read from unshown documents only, so opening the defining file can never
 * steal focus or redirect the insertion away from the user's editor.
 */
export async function instantiateModuleInteract(injectedLogger?: unknown): Promise<void> {
    const log = resolveLogger(injectedLogger);
    const vsc = getVscode();

    // Capture the destination BEFORE any quick pick, input box or document
    // loading: everything below may open other documents, and none of that may
    // influence where the snippet lands.
    const snapshot = captureDestinationSnapshot();
    if (!snapshot) {
        vsc.window.showInformationMessage('HDL-Support: no active editor to insert the instantiation into');
        return;
    }

    const selection = await selectWorkspaceModule(log);
    if (selection.outcome === 'cancelled') {
        return;
    }

    let chosenModule: DocumentSymbol | undefined;
    if (selection.outcome === 'picked') {
        // Read-only enumeration: openTextDocument loads the buffer WITHOUT
        // showing it, so the user's editor keeps focus and cursor.
        const sourceDoc = await vsc.workspace.openTextDocument(vsc.Uri.parse(selection.module.uri));
        const modules = await loadModuleSymbols(sourceDoc.uri, log);
        if (!modules) {
            return;
        }
        // The index may lag behind an unsaved rename; say so instead of
        // silently instantiating a different module.
        chosenModule = modules.find((module) => module.name === selection.module.name);
        if (!chosenModule) {
            vsc.window.showErrorMessage(
                `Verilog-HDL/SystemVerilog: module '${selection.module.name}' is no longer found in ${sourceDoc.fileName}`
            );
            return;
        }
    } else {
        const sourceUri = await selectSourceUri(log);
        if (!sourceUri) {
            return;
        }
        const sourceDoc = await vsc.workspace.openTextDocument(sourceUri);
        const modules = await loadModuleSymbols(sourceDoc.uri, log);
        if (!modules) {
            return;
        }
        chosenModule = await chooseModule(modules);
        if (!chosenModule) {
            return;
        }
    }

    await insertInstantiation(chosenModule, snapshot, log);
}
