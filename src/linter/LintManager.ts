// SPDX-License-Identifier: MIT
import * as vscode from 'vscode';
import ProfileLinter, { LintDiagnosticSet, LintResult, Linter } from './ProfileLinter';
import { findLinterProfile, linterProfiles } from './profiles';
import { Logger } from '../logger';
import { isDiagnosticWaived } from '../clientFeatures/lintWaiversPure';

const HDL_LANGUAGE_IDS = new Set(['verilog', 'systemverilog']);
const DEFAULT_DEBOUNCE_MS = 300;
const OWNER_SEPARATOR = '\n';
const LINTER_CONFIG_SECTIONS = [
  'hdlsupport.verilog',
  'hdlsupport.systemverilog',
  'verilog.linting',
];

/** Reads the `linter` setting: a list of tool IDs, or the single string (`none` disables) older versions used. */
function configuredLinterNames(value: unknown): string[] {
  const names = Array.isArray(value) ? value : [value];
  return [...new Set(names.filter((name): name is string => typeof name === 'string' && name !== '' && name !== 'none'))];
}

export interface LintManagerOptions {
  debounceMs?: number;
  linterFactory?: (name: string, logger: Logger) => Linter | undefined;
}

interface LintRequest {
  document: vscode.TextDocument;
  linter: Linter;
  uriKey: string;
  /** Identifies the linter and document pair; each linter keeps its own pending run and diagnostics. */
  ownerKey: string;
  version: number;
  configKey: string;
  dedupeKey: string;
  configRevision: number;
  force: boolean;
  disposeAfterRun: boolean;
}

interface PendingLint {
  request: LintRequest;
  waiters: Array<(published: boolean) => void>;
  dueAt: number;
}

export default class LintManager implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private readonly logger: Logger;
  private readonly debounceMs: number;
  private readonly linterFactory: LintManagerOptions['linterFactory'];
  private readonly linters = new Set<Linter>();
  private readonly pending = new Map<string, PendingLint>();
  private readonly lastScheduledKeys = new Map<string, string>();
  private readonly latestRequests = new Map<string, LintRequest>();
  private readonly ownedDiagnostics = new Map<string, Map<string, LintDiagnosticSet>>();

  private activeLinters: Linter[] = [];
  private configuredLinterKey = '';
  private configRevision = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private disposed = false;

  constructor(logger: Logger, options: LintManagerOptions = {}) {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection();
    this.logger = logger;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.linterFactory = options.linterFactory;

    this.subscriptions.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        editors.forEach((editor) => this.lintVisibleDocument(editor.document));
      }),
      vscode.workspace.onDidSaveTextDocument((document) => this.lintSavedDocument(document)),
      vscode.workspace.onDidCloseTextDocument((document) => this.removeFileDiagnostics(document)),
      vscode.workspace.onDidChangeConfiguration((event) => this.configLinterOnChange(event))
    );
    this.configLinter();

    // Document-open events are intentionally not used here. VS Code opens documents for
    // indexing and other internal work without displaying them, and those loads must not
    // start an external process.
    vscode.window.visibleTextEditors.forEach((editor) => this.lintVisibleDocument(editor.document));
  }

  public getLinterFromString(name: string): Linter | undefined {
    const logger = this.logger.getChild(`${name}Linter`);
    const linter = this.linterFactory
      ? this.linterFactory(name, logger)
      : this.createDefaultLinter(name, logger);
    if (linter !== undefined) {
      this.linters.add(linter);
    }
    return linter;
  }

  private createDefaultLinter(name: string, logger: Logger): Linter | undefined {
    const profile = findLinterProfile(name);
    return profile ? new ProfileLinter(profile, logger) : undefined;
  }

  public configLinter(): void {
    const names = configuredLinterNames(vscode.workspace.getConfiguration('hdlsupport.verilog.linting').get<unknown>('linter'));
    this.configRevision += 1;
    this.lastScheduledKeys.clear();
    this.latestRequests.clear();
    this.ownedDiagnostics.clear();
    this.cancelPending();
    this.diagnosticCollection.clear();

    if (names.join(',') === this.configuredLinterKey) {
      return;
    }

    this.configuredLinterKey = names.join(',');
    this.activeLinters.splice(0).forEach((linter) => this.disposeLinter(linter));
    this.activeLinters = names.flatMap((name) => {
      const linter = this.getLinterFromString(name);
      if (linter === undefined) {
        this.logger.warn('Invalid linter name: ' + name);
      }
      return linter === undefined ? [] : [linter];
    });
    if (this.activeLinters.length > 0) {
      this.logger.info('Using linters: ' + this.activeLinters.map((linter) => linter.name).join(', '));
    }
  }

  private configLinterOnChange(event?: vscode.ConfigurationChangeEvent): void {
    if (
      event === undefined ||
      LINTER_CONFIG_SECTIONS.some((section) => event.affectsConfiguration(section))
    ) {
      this.configLinter();
      vscode.window.visibleTextEditors.forEach((editor) => this.lintVisibleDocument(editor.document));
    }
  }

  /**
   * Compatibility entry point for callers that already know a document is visible.
   * Automatic callers should use the visibility-aware event handlers below.
   */
  public lint(doc: vscode.TextDocument): void {
    this.lintVisibleDocument(doc);
  }

  private lintVisibleDocument(doc: vscode.TextDocument): void {
    if (!this.isHdlDocument(doc) || !this.isVisible(doc)) {
      return;
    }
    this.activeLinters.forEach((linter) => void this.enqueue(doc, linter, false, false, false));
  }

  private lintSavedDocument(doc: vscode.TextDocument): void {
    if (!this.isHdlDocument(doc)) {
      return;
    }
    this.activeLinters.forEach((linter) => void this.enqueue(doc, linter, false, false, false));
  }

  private isHdlDocument(doc: vscode.TextDocument): boolean {
    return HDL_LANGUAGE_IDS.has(doc.languageId);
  }

  private isVisible(doc: vscode.TextDocument): boolean {
    return vscode.window.visibleTextEditors.some(
      (editor) => this.uriKey(editor.document.uri) === this.uriKey(doc.uri)
    );
  }

  private uriKey(uri: vscode.Uri): string {
    return uri.toString();
  }

  private enqueue(
    document: vscode.TextDocument,
    linter: Linter,
    force: boolean,
    immediate: boolean,
    disposeAfterRun: boolean
  ): Promise<boolean> {
    if (this.disposed) {
      if (disposeAfterRun) {
        this.disposeLinter(linter);
      }
      return Promise.resolve(false);
    }

    const uriKey = this.uriKey(document.uri);
    const ownerKey = `${linter.name}${OWNER_SEPARATOR}${uriKey}`;
    const configKey = `${linter.name}:${this.configRevision}`;
    const dedupeKey = `${document.version}:${configKey}`;
    const request: LintRequest = {
      document,
      linter,
      uriKey,
      ownerKey,
      version: document.version,
      configKey,
      dedupeKey,
      configRevision: this.configRevision,
      force,
      disposeAfterRun,
    };

    if (!force && this.lastScheduledKeys.get(ownerKey) === dedupeKey) {
      if (disposeAfterRun) {
        this.disposeLinter(linter);
      }
      return Promise.resolve(false);
    }

    const replaced = this.pending.get(ownerKey);
    if (replaced !== undefined) {
      replaced.waiters.forEach((waiter) => waiter(false));
      if (replaced.request.disposeAfterRun) {
        this.disposeLinter(replaced.request.linter);
      }
    }

    const pending: PendingLint = {
      request,
      waiters: [],
      dueAt: Date.now() + (immediate ? 0 : this.debounceMs),
    };
    this.pending.set(ownerKey, pending);
    this.lastScheduledKeys.set(ownerKey, dedupeKey);
    this.latestRequests.set(ownerKey, request);

    const completion = new Promise<boolean>((resolve) => pending.waiters.push(resolve));
    this.armNextTimer();
    return completion;
  }

  private armNextTimer(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }

    const nextDueAt = Array.from(this.pending.values()).reduce(
      (earliest, pending) => Math.min(earliest, pending.dueAt),
      Number.POSITIVE_INFINITY
    );
    if (nextDueAt === Number.POSITIVE_INFINITY) {
      this.debounceTimer = undefined;
      return;
    }

    const delay = Math.max(0, nextDueAt - Date.now());
    if (delay === 0) {
      this.debounceTimer = undefined;
      void this.drain();
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.drain();
    }, delay);
  }

  private choosePending(): PendingLint | undefined {
    const now = Date.now();
    for (const pending of this.pending.values()) {
      if (pending.dueAt <= now && pending.request.force) {
        return pending;
      }
    }
    for (const pending of this.pending.values()) {
      if (pending.dueAt <= now) {
        return pending;
      }
    }
    return undefined;
  }

  private async drain(): Promise<void> {
    if (this.disposed || this.running) {
      return;
    }

    const pending = this.choosePending();
    if (pending === undefined) {
      this.armNextTimer();
      return;
    }
    this.pending.delete(pending.request.ownerKey);
    this.running = true;
    let published = false;

    try {
      const result = await pending.request.linter.startLint(pending.request.document);
      if (this.isCurrent(pending.request)) {
        this.publish(pending.request.ownerKey, result);
        published = true;
      } else {
        this.logger.debug(`discarding stale ${pending.request.linter.name} result`);
      }
    } catch (error) {
      this.logger.error(
        `${pending.request.linter.name} lint failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.running = false;
      pending.waiters.forEach((waiter) => waiter(published));
      if (pending.request.disposeAfterRun) {
        this.disposeLinter(pending.request.linter);
      }

      this.armNextTimer();
    }
  }

  private isCurrent(request: LintRequest): boolean {
    return (
      !this.disposed &&
      request.document.version === request.version &&
      request.configRevision === this.configRevision &&
      this.lastScheduledKeys.get(request.ownerKey) === request.dedupeKey &&
      this.latestRequests.get(request.ownerKey) === request
    );
  }

  private publish(ownerKey: string, result: LintResult): void {
    if (result.replaceOwned) {
      this.replaceOwnedDiagnostics(ownerKey, result.diagnostics);
      return;
    }

    if (result.clearExisting) {
      this.ownedDiagnostics.clear();
      this.diagnosticCollection.clear();
    }
    result.diagnostics.forEach((diagnosticSet) => {
      this.publishDiagnosticSet(diagnosticSet.uri, diagnosticSet.diagnostics);
    });
  }

  private replaceOwnedDiagnostics(ownerKey: string, diagnostics: LintDiagnosticSet[]): void {
    const previous = this.ownedDiagnostics.get(ownerKey);
    const replacement = new Map<string, LintDiagnosticSet>();

    diagnostics.forEach((diagnosticSet) => {
      const targetUriKey = this.uriKey(diagnosticSet.uri);
      const existing = replacement.get(targetUriKey);
      if (existing === undefined) {
        replacement.set(targetUriKey, {
          uri: diagnosticSet.uri,
          diagnostics: [...diagnosticSet.diagnostics],
        });
      } else {
        existing.diagnostics.push(...diagnosticSet.diagnostics);
      }
    });

    if (replacement.size === 0) {
      this.ownedDiagnostics.delete(ownerKey);
    } else {
      this.ownedDiagnostics.set(ownerKey, replacement);
    }

    const affected = new Map<string, vscode.Uri>();
    previous?.forEach((diagnosticSet, targetUriKey) => affected.set(targetUriKey, diagnosticSet.uri));
    replacement.forEach((diagnosticSet, targetUriKey) => affected.set(targetUriKey, diagnosticSet.uri));
    affected.forEach((uri, targetUriKey) => this.publishOwnedTarget(targetUriKey, uri));
  }

  private publishOwnedTarget(targetUriKey: string, fallbackUri: vscode.Uri): void {
    const diagnostics: vscode.Diagnostic[] = [];
    const seen = new Set<string>();
    let uri = fallbackUri;

    this.ownedDiagnostics.forEach((snapshot) => {
      const diagnosticSet = snapshot.get(targetUriKey);
      if (diagnosticSet === undefined) {
        return;
      }
      uri = diagnosticSet.uri;
      diagnosticSet.diagnostics.forEach((diagnostic) => {
        const key = this.diagnosticKey(diagnostic);
        if (!seen.has(key)) {
          seen.add(key);
          diagnostics.push(diagnostic);
        }
      });
    });

    if (diagnostics.length === 0) {
      this.diagnosticCollection.delete(uri);
      return;
    }
    this.publishDiagnosticSet(uri, diagnostics);
  }

  private diagnosticKey(diagnostic: vscode.Diagnostic): string {
    const code = typeof diagnostic.code === 'object' && diagnostic.code !== null
      ? diagnostic.code.value
      : diagnostic.code;
    const codeTarget = typeof diagnostic.code === 'object' && diagnostic.code !== null
      ? diagnostic.code.target.toString()
      : undefined;
    return JSON.stringify([
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.range.end.line,
      diagnostic.range.end.character,
      diagnostic.severity,
      diagnostic.message,
      diagnostic.source,
      code,
      codeTarget,
      diagnostic.tags,
      diagnostic.relatedInformation?.map((information) => [
        information.location.uri.toString(),
        information.location.range.start.line,
        information.location.range.start.character,
        information.location.range.end.line,
        information.location.range.end.character,
        information.message,
      ]),
    ]);
  }

  private publishDiagnosticSet(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void {
    const configuration = vscode.workspace.getConfiguration('hdlsupport.verilog.linting', uri);
    const configured = configuration.get<unknown>('waivedDiagnostics', []);
    const configuredWaivers = Array.isArray(configured)
      ? configured.filter((value): value is string => typeof value === 'string')
      : [];
    const document = vscode.workspace.textDocuments?.find(
      (candidate) => this.uriKey(candidate.uri) === this.uriKey(uri)
    );
    const lines = document?.getText().split(/\r?\n/) ?? [];
    const published = diagnostics.filter(
      (diagnostic) => !isDiagnosticWaived(diagnostic, configuredWaivers, lines)
    );
    this.diagnosticCollection.set(uri, published);
  }

  public removeFileDiagnostics(doc: vscode.TextDocument): void {
    const uriKey = this.uriKey(doc.uri);
    const ownedBy = <T>(map: Map<string, T>): Array<[string, T]> =>
      [...map].filter(([ownerKey]) => ownerKey.endsWith(`${OWNER_SEPARATOR}${uriKey}`));

    ownedBy(this.pending).forEach(([ownerKey, pending]) => {
      pending.waiters.forEach((waiter) => waiter(false));
      this.pending.delete(ownerKey);
      if (pending.request.disposeAfterRun) {
        this.disposeLinter(pending.request.linter);
      }
    });
    ownedBy(this.lastScheduledKeys).forEach(([ownerKey]) => this.lastScheduledKeys.delete(ownerKey));
    ownedBy(this.latestRequests).forEach(([ownerKey]) => this.latestRequests.delete(ownerKey));
    const affected = new Map<string, vscode.Uri>([[uriKey, doc.uri]]);
    ownedBy(this.ownedDiagnostics).forEach(([ownerKey, removed]) => {
      this.ownedDiagnostics.delete(ownerKey);
      removed.forEach((diagnosticSet, targetUriKey) => affected.set(targetUriKey, diagnosticSet.uri));
    });
    affected.forEach((uri, targetUriKey) => this.publishOwnedTarget(targetUriKey, uri));
  }

  async runLintTool(): Promise<void> {
    this.logger.info('Executing runLintTool()');
    const initialEditor = vscode.window.activeTextEditor;
    const lang = initialEditor?.document.languageId ?? '';
    if (initialEditor === undefined || !HDL_LANGUAGE_IDS.has(lang)) {
      vscode.window.showErrorMessage('Verilog-HDL/SystemVerilog: No document opened');
      return;
    }

    const linterStr: vscode.QuickPickItem | undefined = await vscode.window.showQuickPick(
      linterProfiles.map(profile => ({ label: profile.id, description: profile.label })),
      {
        matchOnDescription: true,
        placeHolder: 'Choose a linter to run',
      }
    );
    if (linterStr === undefined) {
      this.logger.error('linterStr is undefined');
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Verilog-HDL/SystemVerilog: Running lint tool...',
      },
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined || !HDL_LANGUAGE_IDS.has(editor.document.languageId)) {
          return;
        }

        const active = this.activeLinters.find((candidate) => candidate.name === linterStr.label);
        const linter = active ?? this.getLinterFromString(linterStr.label);
        if (linter === undefined) {
          this.logger.error('Cannot find linter name: ' + linterStr.label);
          return;
        }

        this.logger.info('Using ' + linter.name + ' linter');
        await this.enqueue(
          editor.document,
          linter,
          true,
          true,
          active === undefined
        );
      }
    );
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.cancelPending();
    this.ownedDiagnostics.clear();
    this.subscriptions.splice(0).forEach((subscription) => subscription.dispose());
    this.linters.forEach((linter) => linter.dispose());
    this.linters.clear();
    this.activeLinters = [];
    this.diagnosticCollection.dispose();
  }

  private cancelPending(): void {
    this.pending.forEach((pending) => {
      pending.waiters.forEach((waiter) => waiter(false));
      if (pending.request.disposeAfterRun) {
        this.disposeLinter(pending.request.linter);
      }
    });
    this.pending.clear();
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  private disposeLinter(linter: Linter): void {
    this.linters.delete(linter);
    linter.dispose();
  }
}
