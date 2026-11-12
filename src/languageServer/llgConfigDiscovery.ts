// SPDX-License-Identifier: MIT
// Pure nearest-`llg.toml` resolution shared by the llg client, external
// linters, include links and the open-config command. Must not import vscode.
import { statSync } from 'fs';
import * as path from 'path';

export const LLG_CONFIG_FILE = 'llg.toml';

/** Synchronous regular-file probe for `closestConfigPath`. */
export function isFileSync(candidate: string): boolean {
    try {
        return statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function isInside(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** The `llg.toml` that governs `filePath`: the closest `llg.toml` in the
 *  file's directory or one of its ancestors strictly below `workspaceRoot`,
 *  else `rootConfigPath` (the workspace root's effective config, which
 *  honours `hdlsupport.llg.configPath`). Subdirectories of the file's
 *  directory are never consulted. Without a workspace root the walk continues
 *  to the filesystem root and returns undefined when nothing is found. */
export function closestConfigPath(
    filePath: string,
    workspaceRoot: string | undefined,
    rootConfigPath: string | undefined,
    isFile: (candidate: string) => boolean,
): string | undefined {
    const root = workspaceRoot === undefined ? undefined : path.resolve(workspaceRoot);
    let directory = path.dirname(path.resolve(filePath));
    while (root === undefined || isInside(directory, root)) {
        const candidate = path.join(directory, LLG_CONFIG_FILE);
        if (isFile(candidate)) {
            return candidate;
        }
        const parent = path.dirname(directory);
        if (parent === directory) {
            return undefined;
        }
        directory = parent;
    }
    return rootConfigPath;
}

/** Directories of discovered `llg.toml` files that lie strictly inside one of
 *  the workspace roots; each becomes an extra llg analysis root. Sorted and
 *  de-duplicated so launch snapshots compare by value. */
export function nestedConfigRoots(workspaceRoots: readonly string[], configFiles: readonly string[]): string[] {
    const roots = workspaceRoots.map((root) => path.resolve(root));
    const nested = new Set<string>();
    for (const file of configFiles) {
        if (path.basename(file) !== LLG_CONFIG_FILE) {
            continue;
        }
        const directory = path.dirname(path.resolve(file));
        if (roots.some((root) => isInside(directory, root)) && !roots.includes(directory)) {
            nested.add(directory);
        }
    }
    return [...nested].sort();
}
