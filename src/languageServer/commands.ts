import * as vscode from 'vscode';
import { openLlgConfig } from './configCommand';
import type { LlgClientManager } from './llgClient';
import { LLG_OUTPUT_CHANNEL_NAME } from './llgClient';

export const LLG_RESTART_COMMAND = 'hdlsupport.llg.restart';
export const LLG_OPEN_CONFIG_COMMAND = 'hdlsupport.llg.openConfig';
export const LLG_SHOW_OUTPUT_COMMAND = 'hdlsupport.llg.showOutput';
export const LLG_DUMP_TOKENS_COMMAND = 'hdlsupport.llg.dumpTokens';

export function registerLlgCommands(context: vscode.ExtensionContext, manager: LlgClientManager): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(LLG_RESTART_COMMAND, async () => {
            try {
                await manager.restart();
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(
                    `Restarting the Lapligence language server failed: ${detail}. Check the 'hdlsupport.llg.path' ` +
                        `setting and the '${LLG_OUTPUT_CHANNEL_NAME}' output channel for details.`,
                );
            }
        }),
        vscode.commands.registerCommand(LLG_OPEN_CONFIG_COMMAND, () => openLlgConfig(context)),
        vscode.commands.registerCommand(LLG_SHOW_OUTPUT_COMMAND, () => manager.outputChannel.show(true)),
        vscode.commands.registerCommand(LLG_DUMP_TOKENS_COMMAND, async () => {
            const editor = vscode.window.activeTextEditor;
            if (editor === undefined) {
                void vscode.window.showInformationMessage('Open a Verilog/SystemVerilog file first');
                return;
            }
            const uri = editor.document.uri.toString(true);
            try {
                const lines = await manager.dumpTokens(uri);
                const channel = manager.outputChannel;
                channel.appendLine(`\n=== token dump for ${editor.document.fileName} (${uri}) ===`);
                for (const line of lines) {
                    channel.appendLine(line);
                }
                channel.appendLine(`=== end (${lines.length} tokens) ===`);
                channel.show(true);
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(
                    `Dumping the tokens of '${uri}' failed: ${detail}. Check the '${LLG_OUTPUT_CHANNEL_NAME}' ` +
                        `output channel for details.`,
                );
            }
        }),
    );
}
