// SPDX-License-Identifier: MIT
import * as vscode from 'vscode';

import {
    diagnosticWaiverId,
    isExternalLinterSource,
    LINT_WAIVER_PREFIX,
    verilatorDocumentationUrl,
} from './lintWaiversPure';

const WAIVER_SETTING = 'waivedDiagnostics';

function isExternalDiagnostic(diagnostic: vscode.Diagnostic): boolean {
    return isExternalLinterSource(diagnostic.source);
}

function documentationUri(diagnostic: vscode.Diagnostic): vscode.Uri | undefined {
    const url = verilatorDocumentationUrl(diagnostic);
    return url ? vscode.Uri.parse(url) : undefined;
}

class ExternalLintCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];
        const emitted = new Set<string>();
        for (const diagnostic of context.diagnostics.filter(isExternalDiagnostic)) {
            const id = diagnosticWaiverId(diagnostic);
            if (!id) {
                continue;
            }
            const lineNumber = diagnostic.range.start.line;
            if (lineNumber < 0 || lineNumber >= document.lineCount || emitted.has(`${lineNumber}:${id}`)) {
                continue;
            }
            emitted.add(`${lineNumber}:${id}`);
            const line = document.lineAt(lineNumber);
            const lineAction = new vscode.CodeAction(`Waive ${id} on this line`, vscode.CodeActionKind.QuickFix);
            lineAction.diagnostics = [diagnostic];
            lineAction.isPreferred = false;
            lineAction.edit = new vscode.WorkspaceEdit();
            lineAction.edit.insert(document.uri, line.range.end, ` // ${LINT_WAIVER_PREFIX} ${id}`);
            actions.push(lineAction);

            const workspaceAction = new vscode.CodeAction(`Waive ${id} in this workspace`, vscode.CodeActionKind.QuickFix);
            workspaceAction.diagnostics = [diagnostic];
            workspaceAction.command = {
                command: 'hdlsupport.lint.waiveDiagnostic',
                title: workspaceAction.title,
                arguments: [document.uri, id],
            };
            actions.push(workspaceAction);

            const docs = documentationUri(diagnostic);
            if (docs) {
                const docsAction = new vscode.CodeAction(`Open documentation for ${id}`, vscode.CodeActionKind.Empty);
                docsAction.diagnostics = [diagnostic];
                docsAction.command = { command: 'vscode.open', title: docsAction.title, arguments: [docs] };
                actions.push(docsAction);
            }
        }
        return actions;
    }
}

async function waiveDiagnostic(uri: vscode.Uri, id: string): Promise<void> {
    const normalizedId = id.trim().toLowerCase();
    if (!/^[^\s:]+(?: [^\s:]+)*:[^\s:]+$/.test(normalizedId)) {
        return;
    }
    const configuration = vscode.workspace.getConfiguration('hdlsupport.verilog.linting', uri);
    const configured = configuration.get<unknown>(WAIVER_SETTING, []);
    const current = Array.isArray(configured)
        ? configured.filter((value): value is string => typeof value === 'string')
        : [];
    if (current.some((value) => value.trim().toLowerCase() === normalizedId)) {
        return;
    }
    const target = vscode.workspace.getWorkspaceFolder(uri)
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : vscode.ConfigurationTarget.Workspace;
    await configuration.update(WAIVER_SETTING, [...current, normalizedId].sort(), target);
}

export function registerExternalLintActions(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = [
        { scheme: 'file', language: 'verilog' },
        { scheme: 'file', language: 'systemverilog' },
    ];
    context.subscriptions.push(
        vscode.commands.registerCommand('hdlsupport.lint.waiveDiagnostic', waiveDiagnostic),
        vscode.languages.registerCodeActionsProvider(selector, new ExternalLintCodeActionProvider(), {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty],
        }),
    );
}
