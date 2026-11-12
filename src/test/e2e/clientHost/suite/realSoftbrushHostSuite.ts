// SPDX-License-Identifier: MIT

import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'klcheungaj.hdl-support';
const SOURCE_PATH = process.env.HDLSUPPORT_REAL_SOFTBRUSH_SOURCE ?? '';
const SDC_TEXT = [
    'acme_set_clock_latency -corner fast [get_clocks sys_clk]',
    'create_clock -name sys_clk -period 10 [get_ports clk]',
    '',
].join('\n');
const TCL_TEXT = [
    '# Softbrush host contract',
    'proc scale {value} { return $value }',
    'set count 42',
    '',
].join('\n');
const XDC_TEXT = [
    'acme_route_clock -region north [get_nets sys_clk]',
    'create_clock -name sys_clk -period 10 [get_ports clk]',
    '',
].join('\n');
const BROKEN_TEXT = 'puts "unterminated';

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

function softbrushDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[] {
    return vscode.languages.getDiagnostics(uri).filter((diagnostic) => diagnostic.source === 'softbrush_ls');
}

async function replaceDocument(document: vscode.TextDocument, text: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const lastLine = document.lineAt(document.lineCount - 1);
    edit.replace(
        document.uri,
        new vscode.Range(new vscode.Position(0, 0), lastLine.rangeIncludingLineBreak.end),
        text,
    );
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true, 'failed to edit SDC probe document');
}

describe('real Softbrush through the VS Code extension host', () => {
    mochaHooks.after(async () => {
        if (vscode.window.activeTextEditor?.document.isDirty) {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    it('serves Tcl, SDC, and XDC and survives an explicit language-server restart', async () => {
        assert.ok(SOURCE_PATH !== '', 'HDLSUPPORT_REAL_SOFTBRUSH_SOURCE is required');
        const sdcDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(SOURCE_PATH));
        await vscode.window.showTextDocument(sdcDocument);
        assert.strictEqual(sdcDocument.languageId, 'sdc');

        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, `extension ${EXTENSION_ID} is unavailable`);
        await extension.activate();
        assert.strictEqual(extension.isActive, true);

        const vendorHint = await pollUntil(() => softbrushDiagnostics(sdcDocument.uri).find((diagnostic) =>
            String(diagnostic.code) === 'constraint-unknown-command'
        ) ?? null, 60_000);
        assert.strictEqual(vendorHint.severity, vscode.DiagnosticSeverity.Hint);
        assert.strictEqual(
            softbrushDiagnostics(sdcDocument.uri).some((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error),
            false,
            'vendor extension commands must remain non-fatal',
        );

        const tclDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(path.dirname(SOURCE_PATH), 'script.tcl')));
        await vscode.window.showTextDocument(tclDocument);
        assert.strictEqual(tclDocument.languageId, 'tcl');
        await pollUntil(() => softbrushDiagnostics(tclDocument.uri).length === 0 ? true : null, 60_000);
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
            'vscode.executeDocumentSymbolProvider',
            tclDocument.uri,
        );
        assert.ok(symbols?.some((symbol) => symbol.name === 'scale'), 'Tcl procedure symbol was not provided');
        const semanticTokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
            'vscode.provideDocumentSemanticTokens',
            tclDocument.uri,
        );
        assert.ok(semanticTokens && semanticTokens.data.length > 0, 'Tcl semantic tokens were not provided');

        const xdcDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(path.dirname(SOURCE_PATH), 'pins.xdc')));
        await vscode.window.showTextDocument(xdcDocument);
        assert.strictEqual(xdcDocument.languageId, 'xdc');
        const xdcHint = await pollUntil(() => softbrushDiagnostics(xdcDocument.uri).find((diagnostic) =>
            String(diagnostic.code) === 'constraint-unknown-command'
        ) ?? null, 60_000);
        assert.strictEqual(xdcHint.severity, vscode.DiagnosticSeverity.Hint);
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            xdcDocument.uri,
            new vscode.Position(1, 2),
        );
        const hoverText = hovers?.flatMap((hover) => hover.contents).map((content) =>
            typeof content === 'string' ? content : content.value
        ).join('\n') ?? '';
        assert.match(hoverText, /primary or virtual timing clock/i);

        await replaceDocument(sdcDocument, BROKEN_TEXT);
        const syntaxError = await pollUntil(() => softbrushDiagnostics(sdcDocument.uri).find((diagnostic) =>
            String(diagnostic.code) === 'tcl-syntax'
                && diagnostic.severity === vscode.DiagnosticSeverity.Error
        ) ?? null, 60_000);
        assert.match(syntaxError.message, /unterminated|quote|string/i);

        await replaceDocument(sdcDocument, SDC_TEXT);
        await pollUntil(() => {
            const diagnostics = softbrushDiagnostics(sdcDocument.uri);
            return diagnostics.some((diagnostic) => String(diagnostic.code) === 'constraint-unknown-command')
                && diagnostics.every((diagnostic) => diagnostic.severity !== vscode.DiagnosticSeverity.Error)
                ? true
                : null;
        }, 60_000);

        await vscode.commands.executeCommand('hdlsupport.softbrush.restart');
        await replaceDocument(xdcDocument, BROKEN_TEXT);
        await pollUntil(() => softbrushDiagnostics(xdcDocument.uri).find((diagnostic) =>
            String(diagnostic.code) === 'tcl-syntax'
                && diagnostic.severity === vscode.DiagnosticSeverity.Error
        ) ?? null, 60_000);
        await replaceDocument(xdcDocument, XDC_TEXT);
        await pollUntil(() => {
            const diagnostics = softbrushDiagnostics(xdcDocument.uri);
            return diagnostics.some((diagnostic) => String(diagnostic.code) === 'constraint-unknown-command')
                && diagnostics.every((diagnostic) => diagnostic.severity !== vscode.DiagnosticSeverity.Error)
                ? true
                : null;
        }, 60_000);

        assert.strictEqual(tclDocument.getText(), TCL_TEXT);
        for (const dirtyDocument of [sdcDocument, xdcDocument]) {
            await vscode.window.showTextDocument(dirtyDocument);
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
});
