// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
    class Position {
        constructor(readonly line: number, readonly character: number) {}
    }
    class Range {
        constructor(readonly start: Position, readonly end: Position) {}
    }
    class CompletionItem {
        insertText?: unknown;
        detail?: string;

        constructor(readonly label: string, readonly kind: number) {}
    }
    class SnippetString {
        constructor(readonly value: string) {}
    }
    class Hover {
        constructor(readonly contents: string) {}
    }
    const state = {
        completionProvider: undefined as any,
        hoverProvider: undefined as any,
        entries: [] as Array<[string, number]>,
    };
    return {
        __test: state,
        Position,
        Range,
        CompletionItem,
        SnippetString,
        Hover,
        CompletionItemKind: { Module: 8, Property: 9, File: 17, Folder: 19 },
        FileType: { File: 1, Directory: 2 },
        Uri: { file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }) },
        languages: {
            registerCompletionItemProvider: vi.fn((_selector: unknown, provider: unknown) => {
                state.completionProvider = provider;
                return { dispose: vi.fn() };
            }),
            registerHoverProvider: vi.fn((_selector: unknown, provider: unknown) => {
                state.hoverProvider = provider;
                return { dispose: vi.fn() };
            }),
        },
        workspace: {
            fs: { readDirectory: vi.fn(async () => state.entries) },
        },
    };
});

import * as vscode from 'vscode';
import { registerLlgConfigEditing } from '../../clientFeatures/llgConfigProvider';

interface ProviderState {
    completionProvider?: vscode.CompletionItemProvider;
    hoverProvider?: vscode.HoverProvider;
    entries: Array<[string, number]>;
}

const state = (vscode as typeof vscode & { __test: ProviderState }).__test;

function document(text: string): vscode.TextDocument {
    const lines = text.split('\n');
    return {
        uri: vscode.Uri.file('/workspace/llg.toml'),
        lineAt: (line: number) => ({ text: lines[line] ?? '' }),
        getText: (range?: vscode.Range) => {
            if (!range) {
                return text;
            }
            const before = lines.slice(0, range.end.line).join('\n');
            return `${before}${range.end.line > 0 ? '\n' : ''}${lines[range.end.line]?.slice(0, range.end.character) ?? ''}`;
        },
    } as vscode.TextDocument;
}

function completionItems(
    value: vscode.CompletionItem[] | vscode.CompletionList | null | undefined,
): readonly vscode.CompletionItem[] {
    if (Array.isArray(value)) {
        return value;
    }
    return value?.items ?? [];
}

describe('llg.toml VS Code providers', () => {
    beforeEach(() => {
        state.entries = [];
        registerLlgConfigEditing({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    });

    it('completes known sections and section-specific keys', async () => {
        const sectionDocument = document('[lint.rules.');
        const sections = await state.completionProvider?.provideCompletionItems(
            sectionDocument,
            new vscode.Position(0, 12),
            {} as vscode.CancellationToken,
            {} as vscode.CompletionContext,
        );
        const sourceDocument = document('[sources]\n');
        const fields = await state.completionProvider?.provideCompletionItems(
            sourceDocument,
            new vscode.Position(1, 0),
            {} as vscode.CancellationToken,
            {} as vscode.CompletionContext,
        );

        expect(completionItems(sections).map((item) => item.label)).toEqual(expect.arrayContaining([
            'lint.rules.unused-signal',
            'lint.rules.undriven-signal',
            'lint.rules.incomplete-sensitivity-list',
            'lint.rules.out-of-range-select',
            'lint.rules.xz-logical-equality',
            'lint.rules.duplicate-case-item',
            'lint.rules.empty-implicit-sensitivity',
            'lint.rules.assignment-in-condition',
            'lint.rules.casex-statement',
        ]));
        expect(completionItems(fields).map((item) => item.label)).toEqual(['directories', 'include', 'exclude']);
        expect((completionItems(fields)[0].insertText as vscode.SnippetString).value).toContain('directories =');
    });

    it('completes only matching directories in deterministic order', async () => {
        state.entries = [['rtl', vscode.FileType.Directory], ['readme.txt', vscode.FileType.File], ['regs', vscode.FileType.Directory]];
        const config = document('[sources]\ndirectories = ["r');

        const items = await state.completionProvider?.provideCompletionItems(
            config,
            new vscode.Position(1, 17),
            {} as vscode.CancellationToken,
            {} as vscode.CompletionContext,
        );

        expect(completionItems(items).map((item) => item.label)).toEqual(['regs', 'rtl']);
        expect(completionItems(items).map((item) => item.insertText)).toEqual(['regs/', 'rtl/']);
    });

    it('completes directory entries in multiline arrays but not in the wrong section', async () => {
        state.entries = [['rtl', vscode.FileType.Directory]];
        const multiline = document('[sources]\ndirectories = [\n  "r');
        const wrongSection = document('[analysis]\ndirectories = ["r');

        const multilineItems = await state.completionProvider?.provideCompletionItems(
            multiline,
            new vscode.Position(2, 4),
            {} as vscode.CancellationToken,
            {} as vscode.CompletionContext,
        );
        const wrongSectionItems = await state.completionProvider?.provideCompletionItems(
            wrongSection,
            new vscode.Position(1, 17),
            {} as vscode.CancellationToken,
            {} as vscode.CompletionContext,
        );

        expect(completionItems(multilineItems).map((item) => item.label)).toEqual(['rtl']);
        expect(completionItems(wrongSectionItems).map((item) => item.label)).toEqual([
            'max_file_bytes',
            'max_total_input_bytes',
        ]);
    });

    it('provides section and key documentation hovers', async () => {
        const config = document('[lint]\nenabled = true');

        const sectionHover = await state.hoverProvider?.provideHover(
            config,
            new vscode.Position(0, 2),
            {} as vscode.CancellationToken,
        );
        const keyHover = await state.hoverProvider?.provideHover(
            config,
            new vscode.Position(1, 2),
            {} as vscode.CancellationToken,
        );

        expect((sectionHover as vscode.Hover)?.contents).toContain('[lint]');
        expect((keyHover as vscode.Hover)?.contents).toContain('Globally enable or disable');
    });
});
