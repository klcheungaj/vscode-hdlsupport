// SPDX-License-Identifier: MIT
import * as path from 'path';
import * as vscode from 'vscode';

import { effectiveConfigPath } from '../languageServer/initOptions';
import { closestConfigPath, isFileSync } from '../languageServer/llgConfigDiscovery';

import { extractLiteralIncludes } from './includeLinksPure';
import { extractLlgSearchDirectories } from './llgConfigPure';

const HDL_SELECTOR: vscode.DocumentSelector = [
    { scheme: 'file', language: 'verilog' },
    { scheme: 'file', language: 'systemverilog' },
];

async function isFile(uri: vscode.Uri): Promise<boolean> {
    try {
        return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) !== 0;
    } catch {
        return false;
    }
}

/** The closest governing `llg.toml` (nested configs win over the root one). */
function effectiveConfigUri(document: vscode.TextDocument): vscode.Uri | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    const configured = vscode.workspace.getConfiguration('hdlsupport.llg', document.uri).get<string>('configPath', '').trim();
    const rootConfig = folder === undefined ? undefined : effectiveConfigPath(folder, configured);
    const closest = closestConfigPath(document.uri.fsPath, folder, rootConfig, isFileSync);
    return closest === undefined ? undefined : vscode.Uri.file(closest);
}

async function configuredSearchDirectories(document: vscode.TextDocument): Promise<vscode.Uri[]> {
    const configUri = effectiveConfigUri(document);
    if (!configUri) {
        return [];
    }
    try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(configUri));
        const base = path.dirname(configUri.fsPath);
        return extractLlgSearchDirectories(text).map((entry) => vscode.Uri.file(path.resolve(base, entry.path)));
    } catch {
        return [];
    }
}

async function resolveInclude(document: vscode.TextDocument, includePath: string): Promise<vscode.Uri | undefined> {
    const candidates = [vscode.Uri.file(path.resolve(path.dirname(document.uri.fsPath), includePath))];
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder) {
        candidates.push(vscode.Uri.file(path.resolve(folder.uri.fsPath, includePath)));
    }
    for (const directory of await configuredSearchDirectories(document)) {
        candidates.push(vscode.Uri.file(path.resolve(directory.fsPath, includePath)));
    }
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const key = candidate.toString();
        if (!seen.has(key) && await isFile(candidate)) {
            return candidate;
        }
        seen.add(key);
    }

    if (!folder || path.isAbsolute(includePath) || includePath.includes('..')) {
        return undefined;
    }
    const matches = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, `**/${includePath.replace(/\\/g, '/')}`),
        '**/{.git,node_modules,target,build,dist,out}/**',
        2,
    );
    return matches.length === 1 ? matches[0] : undefined;
}

class LiteralIncludeLinkProvider implements vscode.DocumentLinkProvider {
    private readonly linkData = new WeakMap<vscode.DocumentLink, { document: vscode.TextDocument; path: string }>();

    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        return extractLiteralIncludes(document.getText()).map((include) => {
            const link = new vscode.DocumentLink(
                new vscode.Range(document.positionAt(include.start), document.positionAt(include.end)),
            );
            link.tooltip = `Open included file: ${include.path}`;
            this.linkData.set(link, { document, path: include.path });
            return link;
        });
    }

    async resolveDocumentLink(link: vscode.DocumentLink, _token: vscode.CancellationToken): Promise<vscode.DocumentLink> {
        const data = this.linkData.get(link);
        if (data) {
            link.target = await resolveInclude(data.document, data.path);
        }
        return link;
    }
}

/** Provider access exposed only through the extension's opt-in host-test API. */
export interface LiteralIncludeLinksTestAdapter {
    readonly provider: vscode.DocumentLinkProvider;
}

export function registerLiteralIncludeLinks(context: vscode.ExtensionContext): LiteralIncludeLinksTestAdapter {
    const provider = new LiteralIncludeLinkProvider();
    context.subscriptions.push(vscode.languages.registerDocumentLinkProvider(HDL_SELECTOR, provider));
    return { provider };
}
