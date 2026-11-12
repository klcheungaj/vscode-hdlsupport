import { stat, writeFile } from 'fs/promises';
import * as path from 'path';
import type { ExtensionContext, QuickPickItem, WorkspaceFolder } from 'vscode';
import { effectiveConfigPath, LLG_SECTION } from './initOptions';
import { closestConfigPath, isFileSync } from './llgConfigDiscovery';

// Re-exported so command consumers and tests keep resolving config paths
// through this module while the implementation stays in initOptions.ts.
export { effectiveConfigPath };

type VsCodeApi = typeof import('vscode');

const DEFAULT_CONFIG_FILE = 'llg.toml';

/** The documented Lapligence `llg.toml` v1 template (matches the server's config schema). */
export const CONFIG_TEMPLATE = `schema_version = 1

[sources]
# Directories scanned for compilation units (.v/.sv). Relative paths resolve
# from this file's directory. Defaults to ["."].
directories = ["."]
# Glob filters evaluated within each source directory. Exclude wins.
# include = ["**/*.v", "**/*.sv"]
# exclude = ["**/generated/**"]

[compile]
# top = "top"
# include_dirs = ["include"]
# defines = ["SYNTHESIS", "WIDTH=8"]

[lint]
enabled = true

# Example per-rule override. Rules are enabled by default.
[lint.rules.unused-signal]
# enabled = false

[lint.rules.width-mismatch]
# severity = "error"
`;

/** True when `resolvedPath` is the folder's root-local default config file and
 *  therefore safe to offer creating. Override paths that resolve outside the
 *  workspace root must never be created implicitly. */
export function canOfferTemplateCreation(resolvedPath: string, folderUri: string): boolean {
    return resolvedPath === path.join(folderUri, DEFAULT_CONFIG_FILE);
}

/** Loaded lazily so the pure helpers above stay unit-testable under plain Node,
 *  where the 'vscode' runtime module is unavailable. */
function vsCode(): VsCodeApi {
    return require('vscode') as VsCodeApi;
}

interface FolderChoice {
    folder: WorkspaceFolder;
    effectivePath: string;
}

interface FolderPickItem extends QuickPickItem {
    choice: FolderChoice;
}

/** Opens the `llg.toml` governing the active editor's file when it is a
 *  nested config closer than the workspace root's; otherwise opens the
 *  effective `llg.toml` for a workspace root (in multi-root windows the user
 *  picks the folder first). A missing root-local default file can be
 *  created from the documented template; missing overrides must be created
 *  manually by the user. */
export async function openLlgConfig(context: ExtensionContext): Promise<void> {
    const vscode = vsCode();
    void context;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        void vscode.window.showInformationMessage(
            "Open a workspace folder to edit its 'llg.toml' configuration.",
        );
        return;
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri?.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    if (activeUri && activeFolder) {
        const rootConfig = effectiveConfigPath(
            activeFolder.uri.fsPath,
            vscode.workspace.getConfiguration(LLG_SECTION, activeFolder.uri).get<string>('configPath', ''),
        );
        const closest = closestConfigPath(activeUri.fsPath, activeFolder.uri.fsPath, rootConfig, isFileSync);
        if (closest !== undefined && closest !== rootConfig) {
            await showDocument(vscode, closest);
            return;
        }
    }

    const choices: FolderChoice[] = folders.map((folder) => ({
        folder,
        effectivePath: effectiveConfigPath(
            folder.uri.fsPath,
            vscode.workspace.getConfiguration(LLG_SECTION, folder.uri).get<string>('configPath', ''),
        ),
    }));

    let choice: FolderChoice;
    if (choices.length === 1) {
        [choice] = choices;
    } else {
        const items: FolderPickItem[] = choices.map((entry) => ({
            label: entry.folder.name,
            description: entry.effectivePath,
            choice: entry,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select the workspace whose llg.toml to open',
        });
        if (!picked) {
            return;
        }
        choice = picked.choice;
    }
    await openOrOfferTemplate(vscode, choice.folder.uri.fsPath, choice.effectivePath);
}

async function openOrOfferTemplate(vscode: VsCodeApi, folderFsPath: string, resolvedPath: string): Promise<void> {
    let exists = true;
    try {
        await stat(resolvedPath);
    } catch {
        exists = false;
    }
    if (exists) {
        await showDocument(vscode, resolvedPath);
        return;
    }
    if (!canOfferTemplateCreation(resolvedPath, folderFsPath)) {
        void vscode.window.showInformationMessage(
            `The configured Lapligence configuration '${resolvedPath}' does not exist. Override files outside ` +
                `the workspace root are never created automatically; create it manually.`,
        );
        return;
    }
    const create = 'Create';
    const answer = await vscode.window.showInformationMessage(
        `Create ${DEFAULT_CONFIG_FILE} with the documented template?`,
        { modal: true },
        create,
    );
    if (answer !== create) {
        return;
    }
    try {
        await writeFile(resolvedPath, CONFIG_TEMPLATE, 'utf8');
    } catch (error) {
        void vscode.window.showErrorMessage(
            `Creating '${resolvedPath}' failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
    }
    await showDocument(vscode, resolvedPath);
}

async function showDocument(vscode: VsCodeApi, filePath: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(document);
}
