// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import * as vscode from 'vscode';
import type { LintResult, Linter } from '../../linter/ProfileLinter';
import LintManager from '../../linter/LintManager';
import { Logger } from '../../logger';

const { mockState } = vi.hoisted(() => ({
  mockState: { configuredLinter: 'verilator' as unknown, waivers: [] as unknown },
}));

vi.mock('vscode', () => {
  const makeEvent = () => {
    const listeners: Array<(...args: any[]) => void> = [];
    const event = ((listener: (...args: any[]) => void, thisArg?: unknown, disposables?: any[]) => {
      const callback = thisArg === undefined ? listener : listener.bind(thisArg);
      listeners.push(callback);
      const disposable = {
        dispose: vi.fn(() => {
          const index = listeners.indexOf(callback);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        }),
      };
      disposables?.push(disposable);
      return disposable;
    }) as any;
    event.fire = (...args: any[]) => listeners.slice().forEach((listener) => listener(...args));
    event.listenerCount = () => listeners.length;
    event.clear = () => listeners.splice(0);
    return event;
  };

  const events = {
    visible: makeEvent(),
    save: makeEvent(),
    close: makeEvent(),
    open: makeEvent(),
    config: makeEvent(),
  };
  const collection = {
    values: new Map<string, any[]>(),
    set: vi.fn((uri: { toString(): string }, diagnostics: any[]) => {
      collection.values.set(uri.toString(), diagnostics);
    }),
    delete: vi.fn((uri: { toString(): string }) => {
      collection.values.delete(uri.toString());
    }),
    clear: vi.fn(() => collection.values.clear()),
    dispose: vi.fn(),
  };
  const window = {
    visibleTextEditors: [] as any[],
    activeTextEditor: undefined as any,
    onDidChangeVisibleTextEditors: events.visible,
    showQuickPick: vi.fn(),
    withProgress: vi.fn(async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
      task(undefined, undefined)
    ),
    showErrorMessage: vi.fn(),
  };
  const workspace = {
    workspaceFolders: undefined,
    rootPath: undefined,
    textDocuments: [] as any[],
    onDidSaveTextDocument: events.save,
    onDidCloseTextDocument: events.close,
    onDidOpenTextDocument: events.open,
    onDidChangeConfiguration: events.config,
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string) => {
        if (key === 'linter') {
          return mockState.configuredLinter;
        }
        return key === 'waivedDiagnostics' ? mockState.waivers : undefined;
      }),
    })),
  };

  return {
    __test: { collection, events, window, workspace },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
    ProgressLocation: { Notification: 1 },
    languages: { createDiagnosticCollection: vi.fn(() => collection) },
    window,
    workspace,
  };
});

interface TestVscode {
  __test: {
    collection: {
      values: Map<string, vscode.Diagnostic[]>;
      set: Mock;
      delete: Mock;
      clear: Mock;
      dispose: Mock;
    };
    events: {
      visible: { fire: (editors: any[]) => void; listenerCount: () => number; clear: () => void };
      save: { fire: (document: any) => void; listenerCount: () => number; clear: () => void };
      close: { fire: (document: any) => void; listenerCount: () => number; clear: () => void };
      open: { fire: (document: any) => void; listenerCount: () => number; clear: () => void };
      config: { fire: () => void; listenerCount: () => number; clear: () => void };
    };
    window: {
      visibleTextEditors: any[];
      activeTextEditor: any;
      showQuickPick: Mock;
      withProgress: Mock;
    };
    workspace: { textDocuments: vscode.TextDocument[] };
  };
}

const testVscode = vscode as unknown as TestVscode;

class FakeLinter implements Linter {
  constructor(readonly name = 'verilator') {}
  readonly runs: vscode.TextDocument[] = [];
  readonly completions: Array<(result: LintResult) => void> = [];
  disposeCount = 0;

  startLint(document: vscode.TextDocument): Promise<LintResult> {
    this.runs.push(document);
    return new Promise((resolve) => this.completions.push(resolve));
  }

  resolveNext(diagnostics: vscode.Diagnostic[] = []): void {
    const resolve = this.completions.shift();
    resolve?.({ diagnostics: [{ uri: this.runs[this.runs.length - 1].uri, diagnostics }], clearExisting: false });
  }

  resolveNextResult(result: LintResult): void {
    this.completions.shift()?.(result);
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

const fakeLogger = {
  getChild: vi.fn(() => fakeLogger),
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  show: vi.fn(),
} as unknown as Logger;

function document(version: number, uri = 'file:///tmp/test.sv'): vscode.TextDocument {
  const fileName = uri.replace('file://', '');
  return {
    uri: { toString: () => uri, fsPath: fileName } as vscode.Uri,
    fileName,
    languageId: 'systemverilog',
    version,
    getText: () => 'logic unused;\n',
  } as vscode.TextDocument;
}

function diagnostic(message: string): vscode.Diagnostic {
  return {
    source: 'verilator',
    code: 'verilator',
    message,
    severity: vscode.DiagnosticSeverity.Warning,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
  } as vscode.Diagnostic;
}

function ownedResult(
  sets: Array<{ document: vscode.TextDocument; diagnostics: vscode.Diagnostic[] }>
): LintResult {
  return {
    clearExisting: false,
    replaceOwned: true,
    diagnostics: sets.map(({ document: target, diagnostics }) => ({
      uri: target.uri,
      diagnostics,
    })),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('LintManager scheduling', () => {
  let manager: LintManager;
  let linter: FakeLinter;

  beforeEach(() => {
    vi.useFakeTimers();
    mockState.configuredLinter = 'verilator';
    mockState.waivers = [];
    testVscode.__test.workspace.textDocuments = [];
    testVscode.__test.window.visibleTextEditors = [];
    testVscode.__test.window.activeTextEditor = undefined;
    testVscode.__test.window.showQuickPick.mockReset();
    testVscode.__test.window.withProgress.mockClear();
    testVscode.__test.collection.set.mockClear();
    testVscode.__test.collection.delete.mockClear();
    testVscode.__test.collection.clear.mockClear();
    testVscode.__test.collection.dispose.mockClear();
    testVscode.__test.collection.values.clear();
    Object.values(testVscode.__test.events).forEach((event) => event.clear());

    linter = new FakeLinter();
    manager = new LintManager(fakeLogger, {
      debounceMs: 100,
      linterFactory: () => linter,
    });
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it('ignores internal document loads but lints visible editors and explicit saves', async () => {
    const doc = document(1);

    testVscode.__test.events.open.fire(doc);
    await vi.advanceTimersByTimeAsync(100);
    expect(linter.runs).toHaveLength(0);

    testVscode.__test.window.visibleTextEditors = [{ document: doc }];
    testVscode.__test.events.visible.fire(testVscode.__test.window.visibleTextEditors);
    await vi.advanceTimersByTimeAsync(100);
    expect(linter.runs).toEqual([doc]);
    linter.resolveNext();
    await flushPromises();

    testVscode.__test.window.visibleTextEditors = [];
    const savedDoc = document(2);
    testVscode.__test.events.save.fire(savedDoc);
    await vi.advanceTimersByTimeAsync(100);
    expect(linter.runs).toEqual([doc, savedDoc]);
  });

  it('coalesces saves to the latest version and never overlaps runs', async () => {
    const doc = document(1);
    testVscode.__test.window.visibleTextEditors = [{ document: doc }];
    testVscode.__test.events.visible.fire(testVscode.__test.window.visibleTextEditors);
    await vi.advanceTimersByTimeAsync(100);
    expect(linter.runs).toHaveLength(1);

    (doc as { version: number }).version = 2;
    testVscode.__test.events.save.fire(doc);
    (doc as { version: number }).version = 3;
    testVscode.__test.events.save.fire(doc);
    await vi.advanceTimersByTimeAsync(100);
    expect(linter.runs).toHaveLength(1);

    linter.resolveNext();
    await flushPromises();
    expect(linter.runs).toHaveLength(2);
    expect(linter.runs[1].version).toBe(3);

    linter.resolveNext();
    await flushPromises();
  });

  it('suppresses a result made stale by a newer version', async () => {
    const doc = document(1);
    testVscode.__test.window.visibleTextEditors = [{ document: doc }];
    testVscode.__test.events.visible.fire(testVscode.__test.window.visibleTextEditors);
    await vi.advanceTimersByTimeAsync(100);

    (doc as { version: number }).version = 2;
    testVscode.__test.events.save.fire(doc);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNext();
    await flushPromises();
    expect(testVscode.__test.collection.set).not.toHaveBeenCalled();

    expect(linter.runs).toHaveLength(2);
    linter.resolveNext();
    await flushPromises();
    expect(testVscode.__test.collection.set).toHaveBeenCalledTimes(1);
  });

  it('keeps diagnostics owned by another document when a lint result is clean', async () => {
    const first = document(1, 'file:///tmp/first.sv');
    const second = document(1, 'file:///tmp/second.sv');
    const issue = diagnostic('first issue');

    testVscode.__test.events.save.fire(first);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNextResult(ownedResult([{ document: first, diagnostics: [issue] }]));
    await flushPromises();

    testVscode.__test.events.save.fire(second);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNextResult(ownedResult([]));
    await flushPromises();

    expect(testVscode.__test.collection.values.get(first.uri.toString())).toEqual([issue]);
  });

  it('clears an included file that is absent from its owner latest result', async () => {
    const owner = document(1, 'file:///tmp/top.sv');
    const included = document(1, 'file:///tmp/defs.svh');
    const issue = diagnostic('include issue');

    testVscode.__test.events.save.fire(owner);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNextResult(ownedResult([{ document: included, diagnostics: [issue] }]));
    await flushPromises();
    expect(testVscode.__test.collection.values.get(included.uri.toString())).toEqual([issue]);

    (owner as { version: number }).version = 2;
    testVscode.__test.events.save.fire(owner);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNextResult(ownedResult([]));
    await flushPromises();

    expect(testVscode.__test.collection.values.has(included.uri.toString())).toBe(false);
  });

  it('deduplicates shared include diagnostics and retains remaining owners on close', async () => {
    const first = document(1, 'file:///tmp/first.sv');
    const second = document(1, 'file:///tmp/second.sv');
    const included = document(1, 'file:///tmp/defs.svh');
    const firstIssue = diagnostic('shared issue');
    const secondIssue = diagnostic('shared issue');

    testVscode.__test.events.save.fire(first);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNextResult(ownedResult([{ document: included, diagnostics: [firstIssue] }]));
    await flushPromises();
    testVscode.__test.events.save.fire(second);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNextResult(ownedResult([{ document: included, diagnostics: [secondIssue] }]));
    await flushPromises();

    expect(testVscode.__test.collection.values.get(included.uri.toString())).toEqual([firstIssue]);

    testVscode.__test.events.close.fire(first);
    expect(testVscode.__test.collection.values.get(included.uri.toString())).toEqual([secondIssue]);
  });

  it('does not retain owned diagnostics from stale results', async () => {
    const owner = document(1, 'file:///tmp/top.sv');
    const other = document(1, 'file:///tmp/other.sv');
    const included = document(1, 'file:///tmp/defs.svh');
    const staleIssue = diagnostic('stale issue');
    const currentIssue = diagnostic('current issue');

    testVscode.__test.events.save.fire(owner);
    await vi.advanceTimersByTimeAsync(100);
    (owner as { version: number }).version = 2;
    testVscode.__test.events.save.fire(owner);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNextResult(ownedResult([{ document: included, diagnostics: [staleIssue] }]));
    await flushPromises();
    linter.resolveNextResult(ownedResult([]));
    await flushPromises();

    testVscode.__test.events.save.fire(other);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNextResult(ownedResult([{ document: included, diagnostics: [currentIssue] }]));
    await flushPromises();
    testVscode.__test.events.close.fire(other);

    expect(testVscode.__test.collection.values.has(included.uri.toString())).toBe(false);
  });

  it('deduplicates the same URI, version, and configuration', async () => {
    const doc = document(1);
    testVscode.__test.window.visibleTextEditors = [{ document: doc }];
    testVscode.__test.events.visible.fire(testVscode.__test.window.visibleTextEditors);
    testVscode.__test.events.visible.fire(testVscode.__test.window.visibleTextEditors);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNext();
    await flushPromises();

    testVscode.__test.events.save.fire(doc);
    await vi.advanceTimersByTimeAsync(100);
    expect(linter.runs).toHaveLength(1);

    (doc as { version: number }).version = 2;
    testVscode.__test.events.save.fire(doc);
    await vi.advanceTimersByTimeAsync(100);
    expect(linter.runs).toHaveLength(2);
  });

  it('filters configured external-linter waivers before publishing', async () => {
    const doc = document(1);
    testVscode.__test.workspace.textDocuments = [doc];
    testVscode.__test.window.visibleTextEditors = [{ document: doc }];
    mockState.waivers = ['verilator:verilator'];
    testVscode.__test.events.visible.fire(testVscode.__test.window.visibleTextEditors);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNext([{
      source: 'verilator',
      code: 'verilator',
      message: 'unused signal',
      severity: vscode.DiagnosticSeverity.Warning,
      range: { start: { line: 0 } },
    } as vscode.Diagnostic]);
    await flushPromises();

    expect(testVscode.__test.collection.set).toHaveBeenCalledWith(doc.uri, []);
  });

  it('ignores malformed waiver settings instead of dropping lint output', async () => {
    const doc = document(1);
    const issue = {
      source: 'verilator',
      code: 'verilator',
      message: 'unused signal',
      severity: vscode.DiagnosticSeverity.Warning,
      range: { start: { line: 0 } },
    } as vscode.Diagnostic;
    testVscode.__test.workspace.textDocuments = [doc];
    testVscode.__test.window.visibleTextEditors = [{ document: doc }];
    mockState.waivers = 'not-an-array';

    testVscode.__test.events.visible.fire(testVscode.__test.window.visibleTextEditors);
    await vi.advanceTimersByTimeAsync(100);
    linter.resolveNext([issue]);
    await flushPromises();

    expect(testVscode.__test.collection.set).toHaveBeenCalledWith(doc.uri, [issue]);
  });

  it('invalidates results and dedupe state when configuration changes', async () => {
    const doc = document(1);
    testVscode.__test.window.visibleTextEditors = [{ document: doc }];
    testVscode.__test.events.visible.fire(testVscode.__test.window.visibleTextEditors);
    await vi.advanceTimersByTimeAsync(100);

    testVscode.__test.events.config.fire();
    linter.resolveNext();
    await flushPromises();
    expect(testVscode.__test.collection.set).not.toHaveBeenCalled();

    testVscode.__test.events.save.fire(doc);
    await vi.advanceTimersByTimeAsync(100);
    expect(linter.runs).toHaveLength(2);
  });

  it('keeps external linting disabled in none mode', async () => {
    mockState.configuredLinter = 'none';
    testVscode.__test.events.config.fire();
    const doc = document(1);
    testVscode.__test.window.visibleTextEditors = [{ document: doc }];
    testVscode.__test.events.visible.fire(testVscode.__test.window.visibleTextEditors);
    testVscode.__test.events.save.fire(doc);
    await vi.advanceTimersByTimeAsync(100);

    expect(linter.runs).toHaveLength(0);
    expect(testVscode.__test.collection.clear).toHaveBeenCalled();
  });

  it('runs manual lint through the serialized runner', async () => {
    const doc = document(1);
    testVscode.__test.window.activeTextEditor = { document: doc };
    testVscode.__test.window.showQuickPick.mockResolvedValue({ label: 'verilator' });

    const command = manager.runLintTool();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(0);
    expect(linter.runs).toEqual([doc]);

    linter.resolveNext();
    await command;
    expect(testVscode.__test.window.withProgress).toHaveBeenCalledTimes(1);
  });

  it('disposes listeners, pending work, diagnostics, and linters', async () => {
    const doc = document(1);
    testVscode.__test.window.visibleTextEditors = [{ document: doc }];
    testVscode.__test.events.visible.fire(testVscode.__test.window.visibleTextEditors);
    manager.dispose();
    await vi.advanceTimersByTimeAsync(100);

    expect(linter.runs).toHaveLength(0);
    expect(linter.disposeCount).toBe(1);
    expect(testVscode.__test.collection.dispose).toHaveBeenCalledTimes(1);
    expect(testVscode.__test.events.visible.listenerCount()).toBe(0);
    expect(testVscode.__test.events.save.listenerCount()).toBe(0);
    expect(testVscode.__test.events.close.listenerCount()).toBe(0);
    expect(testVscode.__test.events.config.listenerCount()).toBe(0);
  });
});

describe('LintManager with several linters', () => {
  let manager: LintManager;
  let created: Map<string, FakeLinter>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockState.configuredLinter = ['verilator', 'slang'];
    mockState.waivers = [];
    testVscode.__test.workspace.textDocuments = [];
    testVscode.__test.window.visibleTextEditors = [];
    testVscode.__test.window.showQuickPick.mockReset();
    testVscode.__test.collection.values.clear();
    Object.values(testVscode.__test.events).forEach((event) => event.clear());

    created = new Map();
    manager = new LintManager(fakeLogger, {
      debounceMs: 100,
      linterFactory: (name) => {
        const linter = new FakeLinter(name);
        created.set(name, linter);
        return linter;
      },
    });
  });

  afterEach(() => {
    manager.dispose();
    vi.useRealTimers();
  });

  it('runs every configured linter on a saved document and merges their diagnostics', async () => {
    const doc = document(1);
    const fromVerilator = { ...diagnostic('from verilator'), source: 'verilator' } as vscode.Diagnostic;
    const fromSlang = { ...diagnostic('from slang'), source: 'slang' } as vscode.Diagnostic;

    testVscode.__test.events.save.fire(doc);
    await vi.advanceTimersByTimeAsync(100);
    created.get('verilator')?.resolveNextResult(ownedResult([{ document: doc, diagnostics: [fromVerilator] }]));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(0);
    created.get('slang')?.resolveNextResult(ownedResult([{ document: doc, diagnostics: [fromSlang] }]));
    await flushPromises();

    expect([...created.keys()]).toEqual(['verilator', 'slang']);
    expect(created.get('verilator')?.runs).toEqual([doc]);
    expect(created.get('slang')?.runs).toEqual([doc]);
    expect(testVscode.__test.collection.values.get(doc.uri.toString())).toEqual([fromVerilator, fromSlang]);
  });

  it('keeps one linter\'s diagnostics when another reports a clean run', async () => {
    const doc = document(1);
    const fromVerilator = diagnostic('from verilator');

    testVscode.__test.events.save.fire(doc);
    await vi.advanceTimersByTimeAsync(100);
    created.get('verilator')?.resolveNextResult(ownedResult([{ document: doc, diagnostics: [fromVerilator] }]));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(0);
    created.get('slang')?.resolveNextResult(ownedResult([{ document: doc, diagnostics: [] }]));
    await flushPromises();

    expect(testVscode.__test.collection.values.get(doc.uri.toString())).toEqual([fromVerilator]);

    testVscode.__test.events.close.fire(doc);
    expect(testVscode.__test.collection.values.get(doc.uri.toString())).toBeUndefined();
  });

  it('replaces the active linters when the setting changes', async () => {
    const [verilator, slang] = [created.get('verilator'), created.get('slang')];

    mockState.configuredLinter = ['slang'];
    testVscode.__test.events.config.fire();
    const doc = document(1);
    testVscode.__test.window.visibleTextEditors = [{ document: doc }];
    testVscode.__test.events.visible.fire(testVscode.__test.window.visibleTextEditors);
    await vi.advanceTimersByTimeAsync(100);

    expect(verilator?.disposeCount).toBe(1);
    expect(slang?.disposeCount).toBe(1);
    expect(verilator?.runs).toHaveLength(0);
    expect(created.get('slang')).not.toBe(slang);
    expect(created.get('slang')?.runs).toEqual([doc]);
  });
});
