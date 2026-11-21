import { accessSync, constants as fsConstants, statSync, type Stats } from 'fs';
import { access, stat } from 'fs/promises';
import { delimiter, isAbsolute, join } from 'path';

export interface ResolveInput {
    /** Raw value of hdlsupport.llg.path ('' means unset). */
    settingPath: string;
    platform: string;
    arch: string;
    extensionUri: string;
    /** PATH used to resolve bare executable names; defaults to process.env.PATH. */
    pathEnv?: string;
}

export type ResolveResult =
    | { kind: 'override'; path: string }
    | { kind: 'bundled'; path: string }
    | { kind: 'unsupported'; error: string };

/** VS Code target platforms that ship a bundled server in `server/<target>/`. */
export const BUNDLED_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'win32-x64', 'win32-arm64'] as const;
export type BundledTarget = typeof BUNDLED_TARGETS[number];

/** `<os>-<arch>` names the Lapligence and Softbrush release archives use for each target. */
const ARCHIVE_PLATFORM_NAMES: Record<BundledTarget, string> = {
    ['linux-x64']: 'linux-x86_64',
    ['linux-arm64']: 'linux-arm64',
    ['darwin-arm64']: 'macos-arm64',
    ['win32-x64']: 'windows-x86_64',
    ['win32-arm64']: 'windows-arm64',
};

/** Packaged VSIX file name, e.g. `hdl-support-0.4.1-linux-x86_64.vsix`. */
export function vsixFileName(version: string, target: BundledTarget): string {
    return `hdl-support-${version}-${ARCHIVE_PLATFORM_NAMES[target]}.vsix`;
}

function isBundledTarget(target: string): target is BundledTarget {
    return (BUNDLED_TARGETS as readonly string[]).includes(target);
}

/** File name of a bundled server executable for `platform` (`.exe` on Windows). */
export function bundledBinaryName(binary: string, platform: string): string {
    return platform === 'win32' ? `${binary}.exe` : binary;
}

const PATH_SETTING = 'hdlsupport.llg.path';

export interface ServerIdentity {
    name: string;
    binary: string;
    pathSetting: string;
}

const LLG_IDENTITY: ServerIdentity = { name: 'Lapligence (llg_ls)', binary: 'llg_ls', pathSetting: PATH_SETTING };

export function resolveServerExecutable(input: ResolveInput, identity = LLG_IDENTITY): ResolveResult {
    if (input.settingPath !== '') {
        const isBareName = !/[\\/]/.test(input.settingPath) && !isAbsolute(input.settingPath);
        if (isBareName) {
            const resolved = resolveOnPath(input.settingPath, input.pathEnv, input.platform);
            if (resolved !== null) {
                return { kind: 'override', path: resolved };
            }
            return {
                kind: 'unsupported',
                error:
                    `'${input.settingPath}' was not found on PATH. Install ${identity.name}, make sure its directory ` +
                    `is on PATH, or point '${identity.pathSetting}' at the executable's absolute path.`,
            };
        }
        return { kind: 'override', path: input.settingPath };
    }
    const target = `${input.platform}-${input.arch}`;
    if (isBundledTarget(target)) {
        return {
            kind: 'bundled',
            path: join(input.extensionUri, 'server', target, bundledBinaryName(identity.binary, input.platform)),
        };
    }
    return {
        kind: 'unsupported',
        error:
            `The bundled ${identity.name} language server only supports ${BUNDLED_TARGETS.join(', ')}, ` +
            `but this host is ${input.platform}-${input.arch}. Install ${identity.name} and set '${identity.pathSetting}' ` +
            `to its absolute path or to an executable name on PATH to use the language server here.`,
    };
}

/** Resolve a bare executable name against the PATH env var. Returns the first existing
 *  regular-file match joined with each PATH entry, else null. Empty PATH entries are
 *  skipped rather than treated as the current directory. */
export function resolveOnPath(
    name: string,
    pathEnv: string = process.env.PATH ?? '',
    platform: string = process.platform,
): string | null {
    const candidateNames = platform === 'win32' && !name.toLowerCase().endsWith('.exe')
        ? [name, `${name}.exe`]
        : [name];
    for (const entry of pathEnv.split(delimiter)) {
        if (entry === '') {
            continue;
        }
        for (const candidateName of candidateNames) {
            const candidate = join(entry, candidateName);
            try {
                if (!statSync(candidate).isFile()) {
                    continue;
                }
                accessSync(candidate, fsConstants.X_OK);
            } catch {
                continue;
            }
            return candidate;
        }
    }
    return null;
}

/** Returns an error string when the file at `path` does not exist, is not a regular file,
 *  or lacks execute permission; null when OK. */
export async function validateExecutable(path: string, identity = LLG_IDENTITY): Promise<string | null> {
    let stats: Stats;
    try {
        stats = await stat(path);
    } catch {
        return `The ${identity.name} executable was not found at '${path}'. Check the '${identity.pathSetting}' setting.`;
    }
    if (!stats.isFile()) {
        return `'${path}' is not a regular file. Point '${identity.pathSetting}' at the ${identity.name} executable itself.`;
    }
    try {
        await access(path, fsConstants.X_OK);
    } catch {
        return `'${path}' is not executable. Grant execute permission or fix '${identity.pathSetting}'.`;
    }
    return null;
}
