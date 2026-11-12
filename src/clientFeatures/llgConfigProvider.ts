// SPDX-License-Identifier: MIT
import * as path from 'path';
import * as vscode from 'vscode';

import {
    activeTomlSection,
    configField,
    fieldsForSection,
    keyOnLine,
    LLG_CONFIG_SECTIONS,
    quotedPathPrefix,
} from './llgConfigPure';

const CONFIG_SELECTOR: vscode.DocumentSelector = [{ scheme: 'file', pattern: '**/llg.toml' }];

class LlgConfigCompletionProvider implements vscode.CompletionItemProvider {
    async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.CompletionItem[]> {
        const before = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const currentLine = document.lineAt(position.line).text.slice(0, position.character);
        const section = activeTomlSection(before);
        const pathPrefix = (section === 'sources' || section === 'compile')
            ? quotedPathPrefix(before)
            : undefined;
        if (pathPrefix !== undefined) {
            return this.pathItems(document, pathPrefix);
        }
        if (/^\s*\[[^\]]*$/.test(currentLine)) {
            return LLG_CONFIG_SECTIONS.map((section) => {
                const item = new vscode.CompletionItem(section, vscode.CompletionItemKind.Module);
                item.insertText = section;
                item.detail = `Lapligence [${section}] section`;
                return item;
            });
        }
        return fieldsForSection(section).map((field) => {
            const item = new vscode.CompletionItem(field.key, vscode.CompletionItemKind.Property);
            item.insertText = new vscode.SnippetString(field.insertText);
            item.detail = field.detail;
            return item;
        });
    }

    private async pathItems(document: vscode.TextDocument, prefix: string): Promise<vscode.CompletionItem[]> {
        const slash = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
        const parentPrefix = slash < 0 ? '' : prefix.slice(0, slash + 1);
        const namePrefix = slash < 0 ? prefix : prefix.slice(slash + 1);
        const base = path.resolve(path.dirname(document.uri.fsPath), parentPrefix || '.');
        try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(base));
            return entries
                .filter(([name, type]) => name.startsWith(namePrefix) && (type & vscode.FileType.Directory) !== 0)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name, type]) => {
                    const isDirectory = (type & vscode.FileType.Directory) !== 0;
                    const item = new vscode.CompletionItem(
                        name,
                        isDirectory ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
                    );
                    item.insertText = name + (isDirectory ? '/' : '');
                    item.detail = isDirectory ? 'Directory relative to llg.toml' : 'File relative to llg.toml';
                    return item;
                });
        } catch {
            return [];
        }
    }
}

class LlgConfigHoverProvider implements vscode.HoverProvider {
    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const line = document.lineAt(position.line).text;
        const sectionAtLine = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
        if (sectionAtLine) {
            return new vscode.Hover(`Lapligence configuration section \`[${sectionAtLine}]\`.`);
        }
        const key = keyOnLine(line);
        if (!key) {
            return undefined;
        }
        const before = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
        const field = configField(activeTomlSection(before), key);
        return field ? new vscode.Hover(field.detail) : undefined;
    }
}

export function registerLlgConfigEditing(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(CONFIG_SELECTOR, new LlgConfigCompletionProvider(), '[', '"', "'", '/'),
        vscode.languages.registerHoverProvider(CONFIG_SELECTOR, new LlgConfigHoverProvider()),
    );
}
