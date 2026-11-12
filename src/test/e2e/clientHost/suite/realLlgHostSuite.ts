// SPDX-License-Identifier: MIT

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'klcheungaj.hdl-support';
const SOURCE_PATH = process.env.HDLSUPPORT_REAL_LLG_SOURCE ?? '';
const SECOND_SOURCE_PATH = process.env.HDLSUPPORT_REAL_LLG_SECOND_SOURCE ?? '';
const EXPECTED_WORKSPACE_MODE = process.env.HDLSUPPORT_REAL_LLG_MODE ?? '';

const VALID_TEXT = [
    'module lint_probe (',
    '    input logic clk,',
    '    output logic result',
    ');',
    '    logic unused_sig;',
    '    assign result = clk;',
    'endmodule',
    '',
].join('\n');
const BROKEN_TEXT = 'modul lint_probe;\nendmodule\n';

interface MochaHookApi {
    after(hook: () => void | Promise<void>): void;
}

const mochaHooks = require('mocha') as MochaHookApi;

async function pollUntil<T>(probe: () => T | null, timeoutMs: number, stepMs = 100): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = probe();
        if (value !== null) {
            return value;
        }
        if (Date.now() >= deadline) {
            throw new Error(`condition not met within ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
}

function llgDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
    return vscode.languages.getDiagnostics(uri).filter((diagnostic) =>
        diagnostic.source === 'llg' || diagnostic.source === 'llg-lint',
    );
}

function unusedSignalDiagnostic(uri: vscode.Uri): vscode.Diagnostic | null {
    return llgDiagnostics(uri).find((diagnostic) =>
        diagnostic.source === 'llg-lint' && String(diagnostic.code) === 'unused-signal',
    ) ?? null;
}

function syntaxErrorDiagnostic(uri: vscode.Uri): vscode.Diagnostic | null {
    return vscode.languages.getDiagnostics(uri).find((diagnostic) =>
        diagnostic.severity === vscode.DiagnosticSeverity.Error,
    ) ?? null;
}

async function replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const lastLine = document.lineAt(document.lineCount - 1);
    edit.replace(
        document.uri,
        new vscode.Range(new vscode.Position(0, 0), lastLine.rangeIncludingLineBreak.end),
        text,
    );
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true, 'failed to edit probe document');
}

async function exerciseDiagnosticLifecycle(sourcePath: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
    await vscode.window.showTextDocument(document);

    let baseline: vscode.Diagnostic;
    try {
        baseline = await pollUntil(() => unusedSignalDiagnostic(document.uri), 60_000);
    } catch (error) {
        const observed = vscode.languages.getDiagnostics(document.uri).map((diagnostic) => ({
            source: diagnostic.source,
            code: diagnostic.code,
            severity: diagnostic.severity,
            message: diagnostic.message,
        }));
        throw new Error(
            `unused-signal diagnostic did not arrive for ${document.uri.toString()}; `
            + `observed=${JSON.stringify(observed)}`,
            { cause: error },
        );
    }
    assert.strictEqual(baseline.source, 'llg-lint');
    assert.strictEqual(baseline.severity, vscode.DiagnosticSeverity.Warning);
    assert.match(baseline.message, /unused_sig/);

    await replaceDocument(document, BROKEN_TEXT);
    const syntaxError = await pollUntil(() => syntaxErrorDiagnostic(document.uri), 60_000);
    assert.strictEqual(syntaxError.severity, vscode.DiagnosticSeverity.Error);

    await replaceDocument(document, VALID_TEXT);
    await pollUntil(() => {
        const diagnostics = vscode.languages.getDiagnostics(document.uri);
        return diagnostics.every((diagnostic) => diagnostic.severity !== vscode.DiagnosticSeverity.Error)
            && unusedSignalDiagnostic(document.uri) !== null
            ? true
            : null;
    }, 60_000);

    // End each state sequence like a user closing an unsaved-but-restored file.
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

describe('real llg diagnostics through the VS Code extension host', () => {
    mochaHooks.after(async () => {
        if (vscode.window.activeTextEditor?.document.isDirty) {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('lints open source, reports an unsaved syntax error, and clears it after recovery', async () => {
        // Arrange: this fixture deliberately has no llg.toml, exercising llg defaults.
        assert.ok(SOURCE_PATH !== '', 'HDLSUPPORT_REAL_LLG_SOURCE is required');
        assert.ok(EXPECTED_WORKSPACE_MODE === 'folder' || EXPECTED_WORKSPACE_MODE === 'single-file');
        if (EXPECTED_WORKSPACE_MODE === 'folder') {
            assert.ok(vscode.workspace.workspaceFolders?.length === 1, 'folder probe has no workspace');
        } else {
            assert.strictEqual(vscode.workspace.workspaceFolders, undefined, 'single-file probe unexpectedly has a workspace');
        }

        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, `extension ${EXTENSION_ID} is unavailable`);
        const initialDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(SOURCE_PATH));
        await vscode.window.showTextDocument(initialDocument);
        await extension.activate();
        assert.strictEqual(extension.isActive, true);

        // Act / Assert: a default lint rule must travel through vscode-languageclient.
        await exerciseDiagnosticLifecycle(SOURCE_PATH);

        if (EXPECTED_WORKSPACE_MODE === 'single-file') {
            assert.ok(SECOND_SOURCE_PATH !== '', 'single-file probe requires a second source path');
            await exerciseDiagnosticLifecycle(SECOND_SOURCE_PATH);
        }
    });
});
