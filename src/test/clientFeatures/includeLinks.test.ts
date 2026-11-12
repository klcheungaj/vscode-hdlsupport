// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
    class Uri {
        private constructor(readonly fsPath: string) {}

        static file(fsPath: string): Uri {
            return new Uri(fsPath);
        }

        static joinPath(base: Uri, ...segments: string[]): Uri {
            return Uri.file([base.fsPath.replace(/\/$/, ''), ...segments].join('/'));
        }

        toString(): string {
            return `file://${this.fsPath}`;
        }
    }
    class Range {
        constructor(readonly start: unknown, readonly end: unknown) {}
    }
    class DocumentLink {
        target?: Uri;
        tooltip?: string;

        constructor(readonly range: Range) {}
    }
    class RelativePattern {
        constructor(readonly base: unknown, readonly pattern: string) {}
    }
    const state = {
        provider: undefined as any,
        files: new Set<string>(),
        configText: '',
        configPath: '',
        fallback: [] as Uri[],
    };
    return {
        __test: state,
        Uri,
        Range,
        DocumentLink,
        RelativePattern,
        FileType: { File: 1, Directory: 2 },
        languages: {
            registerDocumentLinkProvider: vi.fn((_selector: unknown, provider: unknown) => {
                state.provider = provider;
                return { dispose: vi.fn() };
            }),
        },
        workspace: {
            getWorkspaceFolder: vi.fn(() => ({ name: 'workspace', uri: Uri.file('/workspace') })),
            getConfiguration: vi.fn(() => ({ get: vi.fn(() => state.configPath) })),
            findFiles: vi.fn(async () => state.fallback),
            fs: {
                stat: vi.fn(async (uri: Uri) => {
                    if (!state.files.has(uri.fsPath)) {
                        throw new Error('not found');
                    }
                    return { type: 1 };
                }),
                readFile: vi.fn(async (uri: Uri) => {
                    if (uri.fsPath !== '/workspace/llg.toml' && uri.fsPath !== state.configPath) {
                        throw new Error('not found');
                    }
                    return Buffer.from(state.configText);
                }),
            },
        },
    };
});

import * as vscode from 'vscode';
import { registerLiteralIncludeLinks } from '../../clientFeatures/includeLinks';

interface LinkState {
    provider?: vscode.DocumentLinkProvider;
    files: Set<string>;
    configText: string;
    configPath: string;
    fallback: vscode.Uri[];
}

const state = (vscode as typeof vscode & { __test: LinkState }).__test;

function document(source: string, file = '/workspace/rtl/top.sv'): vscode.TextDocument {
    return {
        uri: vscode.Uri.file(file),
        getText: () => source,
        positionAt: (offset: number) => ({ line: 0, character: offset }),
    } as vscode.TextDocument;
}

describe('literal include document links', () => {
    beforeEach(() => {
        state.files.clear();
        state.configText = '';
        state.configPath = '';
        state.fallback = [];
        registerLiteralIncludeLinks({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    });

    it('resolves an include beside the containing document', async () => {
        state.files.add('/workspace/rtl/defs.svh');
        const source = '`include "defs.svh"';
        const doc = document(source);

        const links = await state.provider?.provideDocumentLinks(doc, {} as vscode.CancellationToken) ?? [];
        const resolved = await state.provider?.resolveDocumentLink?.(links[0], {} as vscode.CancellationToken);

        expect(links).toHaveLength(1);
        expect(source.slice((links[0].range.start as any).character, (links[0].range.end as any).character)).toBe('defs.svh');
        expect(resolved?.target?.fsPath).toBe('/workspace/rtl/defs.svh');
    });

    it('resolves through multiline llg.toml source and include directories', async () => {
        state.configText = '[compile]\ninclude_dirs = [\n  "include"\n]\n';
        state.files.add('/workspace/include/common.svh');
        const doc = document('`include "common.svh"');

        const links = await state.provider?.provideDocumentLinks(doc, {} as vscode.CancellationToken) ?? [];
        const resolved = await state.provider?.resolveDocumentLink?.(links[0], {} as vscode.CancellationToken);

        expect(resolved?.target?.fsPath).toBe('/workspace/include/common.svh');
    });

    it('honors an absolute configuration override and leaves ambiguous fallback matches unresolved', async () => {
        state.configPath = '/configs/custom.toml';
        state.configText = '[sources]\ndirectories = ["../shared"]\n';
        state.fallback = [vscode.Uri.file('/workspace/a/defs.svh'), vscode.Uri.file('/workspace/b/defs.svh')];
        const doc = document('`include "defs.svh"');

        const links = await state.provider?.provideDocumentLinks(doc, {} as vscode.CancellationToken) ?? [];
        const resolved = await state.provider?.resolveDocumentLink?.(links[0], {} as vscode.CancellationToken);

        expect(resolved?.target).toBeUndefined();
    });

    it('uses a unique workspace fallback match', async () => {
        state.fallback = [vscode.Uri.file('/workspace/generated/defs.svh')];
        const doc = document('`include "defs.svh"');

        const links = await state.provider?.provideDocumentLinks(doc, {} as vscode.CancellationToken) ?? [];
        const resolved = await state.provider?.resolveDocumentLink?.(links[0], {} as vscode.CancellationToken);

        expect(resolved?.target?.fsPath).toBe('/workspace/generated/defs.svh');
    });
});
