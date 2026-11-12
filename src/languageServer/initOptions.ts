import * as path from 'path';
import { pathToFileURL } from 'url';

export interface WorkspaceFolderInfo {
    /** fsPath of the workspace folder. */
    uri: string;
    name: string;
}

export interface LlgInitOptions {
    llg: {
        protocolVersion: 1;
        configFiles: Array<{ workspaceUri: string; path: string }>;
    };
}

const DEFAULT_CONFIG_FILE = 'llg.toml';

/** VS Code settings section shared by all Lapligence client code. */
export const LLG_SECTION = 'hdlsupport.llg';

/** Builds the versioned initialization payload with one effective `llg.toml`
 *  location per workspace root, in input order. */
export function buildInitializationOptions(
    folders: WorkspaceFolderInfo[],
    configPathFor: (folderUri: string) => string,
): LlgInitOptions {
    const configFiles = folders.map((folder) => ({
        workspaceUri: pathToFileURL(folder.uri).href,
        path: effectiveConfigPath(folder.uri, configPathFor(folder.uri)),
    }));
    return { llg: { protocolVersion: 1, configFiles } };
}

/** Effective `llg.toml` path for a workspace root: an empty setting means the
 *  root-local default file, relative values resolve from the root, absolute
 *  values pass through. Single source of truth also used by the open-config
 *  command. */
export function effectiveConfigPath(folderUri: string, rawConfigPath: string): string {
    if (!rawConfigPath) {
        return path.join(folderUri, DEFAULT_CONFIG_FILE);
    }
    if (path.isAbsolute(rawConfigPath)) {
        return rawConfigPath;
    }
    return path.resolve(folderUri, rawConfigPath);
}
