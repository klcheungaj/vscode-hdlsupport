// SPDX-License-Identifier: MIT
//
// Inactive-region dimming for Verilog/SystemVerilog buffers: branches skipped
// by conditional-compilation directives (`` `ifdef``/`` `ifndef``/`` `elsif``/
// `` `else``/`` `endif`` under the effective llg.toml defines) render dimmed
// so users see at a glance that they are not parsed.
//
// This is a DECORATION controller, not a language provider - all range
// computation lives server-side (`llg/inactiveRanges`); this class only
// fetches ranges through the llgClient manager and applies them. Decision
// logic (validation, merging, debouncing) stays in the pure seam
// inactiveRegionsPure.ts.
//
// Refetch triggers: didOpen/didSave, debounced didChange bursts,
// hdlsupport.llg.{path,configPath,logLevel} changes, and the server's
// `llg/configChanged` push fired when an effective llg.toml reload changed
// backend state (e.g. `[compile] defines`) - without it, dimming of every
// open buffer stayed stale after such an edit. Editor switches repaint from
// the version-checked per-document cache.

import * as vscode from 'vscode';
import type { LlgClientManager } from '../languageServer/llgClient';
import { Logger } from '../logger';
import {
    cachedRangesAreCurrent,
    createTrailingDebounce,
    INACTIVE_REGION_DEBOUNCE_MS,
    inactiveRangesEqual,
    PureInactiveRange,
    sanitizeInactiveRanges,
} from './inactiveRegionsPure';

const LLG_SECTION = 'hdlsupport.llg';

function isHdlDocument(document: vscode.TextDocument | undefined): boolean {
    return (
        document !== undefined &&
        document.uri.scheme === 'file' &&
        (document.languageId === 'verilog' || document.languageId === 'systemverilog')
    );
}

export class InactiveRegionController implements vscode.Disposable {
    private readonly decoration: vscode.TextEditorDecorationType;
    /** Last fetched ranges per document URI, so editor switches repaint from
     *  memory instead of refetching. */
    private readonly cachedRanges = new Map<string, readonly PureInactiveRange[]>();
    /** Document version of the ranges in cachedRanges. */
    private readonly appliedVersions = new Map<string, number>();
    /** Version requested most recently per URI; stale responses are dropped. */
    private readonly requestedVersions = new Map<string, number>();
    private readonly pendingUris = new Set<string>();
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly debouncedFetch = createTrailingDebounce(
        () => this.fetchPending(),
        INACTIVE_REGION_DEBOUNCE_MS,
    );
    private readonly debouncedConfigRefetch = createTrailingDebounce(
        () => this.refetchAll(),
        INACTIVE_REGION_DEBOUNCE_MS,
    );
    /** Set by dispose(): in-flight fetches must not touch editors after it. */
    private disposed = false;

    constructor(
        private readonly manager: LlgClientManager,
        private readonly logger?: Logger,
    ) {
        // Match how C/C++ extensions render disabled preprocessor code: a
        // dimmed text style plus a neutral overview-ruler mark.
        this.decoration = vscode.window.createTextEditorDecorationType({
            opacity: '0.4',
            overviewRulerColor: '#7f7f7f',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        });
        this.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument((document) => this.fetchNow(document)),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (!isHdlDocument(event.document)) {
                    return;
                }
                // Trailing-edge debounce with latest-wins coalescing, mirroring
                // the analysis-refresh policy on both sides of the protocol.
                this.pendingUris.add(event.document.uri.toString());
                this.debouncedFetch.schedule();
            }),
            vscode.workspace.onDidSaveTextDocument((document) => this.fetchNow(document)),
            vscode.workspace.onDidCloseTextDocument((document) => this.clearDocument(document)),
            vscode.workspace.onDidChangeConfiguration((event) => {
                const affectsLlg = ['path', 'configPath', 'logLevel'].some((key) =>
                    event.affectsConfiguration(`${LLG_SECTION}.${key}`),
                );
                if (affectsLlg) {
                    this.refetchAll();
                }
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => this.repaintAll()),
            // The server hot-reloads llg.toml content itself (diagnostics
            // republish immediately) and PUSHES `llg/configChanged` when an
            // effective config changed — e.g. a `[compile] defines` edit.
            // Without this, dimming on every open buffer stayed wrong until
            // the next buffer event. Debounced + coalesced like every other
            // refetch trigger; the manager re-fires the handler across
            // server restarts.
            this.manager.onConfigChanged(() => this.debouncedConfigRefetch.schedule()),
        );
    }

    dispose(): void {
        this.disposed = true;
        this.debouncedFetch.cancel();
        this.debouncedConfigRefetch.cancel();
        this.cachedRanges.clear();
        this.appliedVersions.clear();
        this.requestedVersions.clear();
        this.pendingUris.clear();
        this.decoration.dispose();
        this.subscriptions.forEach((subscription) => subscription.dispose());
    }

    /** Fetches immediately (didOpen / didSave / settings change). */
    private fetchNow(document: vscode.TextDocument): void {
        if (!isHdlDocument(document)) {
            return;
        }
        this.pendingUris.delete(document.uri.toString());
        void this.request(document);
    }

    private refetchAll(): void {
        for (const document of vscode.workspace.textDocuments) {
            if (isHdlDocument(document)) {
                void this.request(document);
            }
        }
    }

    private fetchPending(): void {
        const uris = [...this.pendingUris];
        this.pendingUris.clear();
        for (const uri of uris) {
            const document = vscode.workspace.textDocuments.find(
                (candidate) => candidate.uri.toString() === uri,
            );
            if (document !== undefined) {
                void this.request(document);
            } else {
                // The buffer went away during the quiet period.
                this.clearCachedState(uri);
            }
        }
    }

    private async request(document: vscode.TextDocument): Promise<void> {
        const uri = document.uri.toString();
        const version = document.version;
        this.requestedVersions.set(uri, version);
        try {
            const rawRanges = await this.manager.getInactiveRanges(uri);
            if (this.disposed || this.requestedVersions.get(uri) !== version) {
                return;
            }
            const ranges = sanitizeInactiveRanges(rawRanges, document.lineCount);
            const previousVersion = this.appliedVersions.get(uri);
            const previousRanges = this.cachedRanges.get(uri);
            this.appliedVersions.set(uri, version);
            this.cachedRanges.set(uri, ranges);
            if (
                previousVersion === version &&
                previousRanges !== undefined &&
                inactiveRangesEqual(previousRanges, ranges)
            ) {
                return;
            }
            this.applyToEditors(uri, ranges);
        } catch (error) {
            // The server may not be running yet; the next trigger retries.
            this.logger?.debug(
                `fetching inactive ranges failed for ${document.uri.fsPath}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private clearDocument(document: vscode.TextDocument): void {
        const uri = document.uri.toString();
        this.clearCachedState(uri);
        this.applyToEditors(uri, []);
    }

    private clearCachedState(uri: string): void {
        this.cachedRanges.delete(uri);
        this.appliedVersions.delete(uri);
        this.requestedVersions.delete(uri);
        this.pendingUris.delete(uri);
    }

    private repaintAll(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            const uri = editor.document.uri.toString();
            const ranges = this.cachedRanges.get(uri);
            // Skip stale cache entries: if the document changed since the
            // cached fetch, repainting would dim outdated content until the
            // (already scheduled) refetch lands.
            if (
                ranges !== undefined &&
                isHdlDocument(editor.document) &&
                cachedRangesAreCurrent(this.appliedVersions.get(uri), editor.document.version)
            ) {
                this.apply(editor, ranges);
            }
        }
    }

    private applyToEditors(uri: string, ranges: readonly PureInactiveRange[]): void {
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() === uri) {
                this.apply(editor, ranges);
            }
        }
    }

    private apply(editor: vscode.TextEditor, ranges: readonly PureInactiveRange[]): void {
        editor.setDecorations(
            this.decoration,
            ranges.map(
                (range) =>
                    new vscode.Range(
                        new vscode.Position(range.start, 0),
                        editor.document.lineAt(Math.min(range.end, editor.document.lineCount - 1))
                            .range.end,
                    ),
            ),
        );
    }
}
