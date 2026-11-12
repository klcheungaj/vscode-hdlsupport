// SPDX-License-Identifier: MIT
import * as vscode from 'vscode';
import type { ModuleExplorerController } from './moduleExplorer';

export const MODULES_REFRESH_COMMAND = 'hdlsupport.modules.refresh';
export const MODULES_GOTO_COMMAND = 'hdlsupport.modules.gotoDefinition';

export function registerModuleExplorerCommands(
    context: vscode.ExtensionContext,
    explorer: ModuleExplorerController,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(MODULES_REFRESH_COMMAND, async () => {
            try {
                await explorer.refresh();
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Refreshing the HDL module hierarchy failed: ${detail}`);
            }
        }),
        vscode.commands.registerCommand(MODULES_GOTO_COMMAND, async (target?: unknown) => {
            try {
                await explorer.reveal(target);
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Opening the module source failed: ${detail}`);
            }
        }),
    );
}
