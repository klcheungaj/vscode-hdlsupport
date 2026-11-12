// SPDX-License-Identifier: MIT
// Pure derivation of external-linter include directories from `llg.toml`
// text. Must not import vscode.
import * as path from 'path';
import { extractLlgSearchDirectories } from '../clientFeatures/llgConfigPure';

/** Directories named by an `llg.toml`, resolved against its directory:
 *  `[sources] directories` (the server default `.` when absent, i.e. the
 *  config directory itself) followed by `[compile] include_dirs`. */
export function llgConfigDirectories(configText: string, configDirectory: string): string[] {
    const entries = extractLlgSearchDirectories(configText);
    const sources = entries.filter((entry) => entry.section === 'sources').map((entry) => entry.path);
    const includes = entries.filter((entry) => entry.section === 'compile').map((entry) => entry.path);
    return [...(sources.length > 0 ? sources : ['.']), ...includes]
        .map((directory) => path.resolve(configDirectory, directory));
}

export interface LinterIncludeInput {
    documentDirectory: string;
    /** Used when no readable `llg.toml` governs the file: workspace root, else the document directory. */
    fallbackDirectory: string;
    configPath: string | undefined;
    /** Text of `configPath`; undefined when there is no config or it is unreadable. */
    configText: string | undefined;
}

/** The document's own directory first, then the governing `llg.toml`'s
 *  directories (or the fallback directory); de-duplicated. */
export function linterIncludeDirectories(input: LinterIncludeInput): string[] {
    const configured = input.configPath !== undefined && input.configText !== undefined
        ? llgConfigDirectories(input.configText, path.dirname(input.configPath))
        : [input.fallbackDirectory];
    return [...new Set([input.documentDirectory, ...configured])];
}
