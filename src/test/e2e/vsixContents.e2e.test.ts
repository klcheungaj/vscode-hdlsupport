import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { assertExecutableLinkage } from '../support/executableLinkage';
import { assertMimallocProtocolAllocations } from '../support/mimalloc';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const VSIX_PATH = path.join(REPO_ROOT, 'hdl-support-linux-x64.vsix');
const ARCHIVE_SERVER_ENTRIES = [
    'extension/server/linux-x64/llg_ls',
    'extension/server/linux-x64/softbrush_ls',
] as const;
const VSCE_LIST_TIMEOUT_MS = 120_000;

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * Packaging contract: whatever ships in hdl-support-linux-x64.vsix must include
 * both bundled language servers and runtime assets, and must exclude sources,
 * build artifacts and legacy indexer leftovers.
 */

interface PackageListing {
    readonly files: string[];
    readonly servers: ReadonlyMap<string, ServerEntry>;
}

interface ServerEntry {
    readonly size: number;
    readonly executable: boolean;
}

/** Lists and inspects the produced archive itself; source listing is not a package contract. */
async function collectPackagedFiles(): Promise<PackageListing> {
    const [stdout, zipInfo] = await Promise.all([
        runUnzipListing(),
        runZipInfoListing(),
    ]);
    return {
        files: parseUnzipListing(stdout),
        servers: new Map(ARCHIVE_SERVER_ENTRIES.map((entry) => [entry, parseZipInfoServer(zipInfo, entry)])),
    };
}

function runUnzipListing(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        execFile('unzip', ['-l', VSIX_PATH], { cwd: REPO_ROOT, timeout: VSCE_LIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
            if (error !== null) {
                reject(error instanceof Error ? error : new Error(String(error)));
            } else {
                resolve(stdout);
            }
        });
    });
}

function runZipInfoListing(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        execFile('zipinfo', ['-l', VSIX_PATH], { cwd: REPO_ROOT, timeout: VSCE_LIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
            if (error !== null) {
                reject(error instanceof Error ? error : new Error(String(error)));
            } else {
                resolve(stdout);
            }
        });
    });
}

function parseZipInfoServer(output: string, archiveEntry: string): ServerEntry {
    const line = splitLines(output).find((candidate) => candidate.endsWith(` ${archiveEntry}`));
    if (line === undefined) {
        throw new Error(`zipinfo did not list the required archive member ${archiveEntry}`);
    }
    const columns = line.split(/\s+/);
    const size = Number.parseInt(columns[3] ?? '', 10);
    if (!Number.isSafeInteger(size) || size <= 0) {
        throw new Error(`zipinfo returned no usable size for ${archiveEntry}`);
    }
    return {
        size,
        executable: /x/.test(columns[0] ?? ''),
    };
}

function splitLines(output: string): string[] {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

/** Extracts archive member names from `unzip -l` output (skips headers/footers). */
function parseUnzipListing(output: string): string[] {
    return splitLines(output)
        .map((line) => line.split(/\s{2,}/).pop() ?? '')
        .filter((name) => name.includes('/'))
        .filter((name) => !name.endsWith('/'));
}

/**
 * Normalizes a packaged entry to a repo-root-relative POSIX path:
 * backslashes become slashes and the archive's `extension/` prefix is removed.
 */
function normalizeEntry(entry: string): string {
    let normalized = entry.trim().replace(/\\/g, '/');
    if (normalized.startsWith('extension/')) {
        normalized = normalized.slice('extension/'.length);
    }
    return normalized;
}

describe('[packaging contract] hdl-support-linux-x64.vsix contents', () => {
    let extractedDirectory: string | undefined;
    const extractedServers = new Map<string, string>();
    let files: string[];
    let servers: ReadonlyMap<string, ServerEntry>;

    beforeAll(async () => {
        const listing = await collectPackagedFiles();
        files = [...new Set(listing.files.map(normalizeEntry))];
        servers = listing.servers;
        expect(files.length).toBeGreaterThan(0);
        extractedDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hdl-package-binaries-'));
        for (const entry of ARCHIVE_SERVER_ENTRIES) {
            const { stdout } = await promisify(execFile)('unzip', ['-p', VSIX_PATH, entry], {
                encoding: 'buffer', timeout: VSCE_LIST_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024,
            });
            const extracted = path.join(extractedDirectory, path.basename(entry));
            await fs.promises.writeFile(extracted, stdout, { mode: 0o755 });
            extractedServers.set(path.basename(entry), extracted);
        }
    }, 150_000);

    afterAll(async () => {
        if (extractedDirectory) {
            await fs.promises.rm(extractedDirectory, { recursive: true, force: true });
        }
    });

    for (const name of ['llg_ls', 'softbrush_ls']) {
        it(`ships a fully static Linux ${name}`, async () => {
            await assertExecutableLinkage(extractedServers.get(name)!, 'linux');
        });

        it(`ships ${name} using mimalloc for default protocol allocations`, async () => {
            await assertMimallocProtocolAllocations(extractedServers.get(name)!);
        });
    }

    it('ships the runtime assets required by both language servers', () => {
        for (const required of [
            'server/linux-x64/llg_ls',
            'server/linux-x64/softbrush_ls',
            'dist/extension.js',
            'package.json',
            'doc/llg.example.toml',
            'schemas/llg.schema.json',
            'syntaxes/systemverilog.tmLanguage.json',
            'syntaxes/tcl-language-configuration.json',
            'syntaxes/tcl.tmLanguage.json',
            'syntaxes/sdc.tmLanguage.json',
            'syntaxes/xdc.tmLanguage.json',
        ]) {
            expect(files).toContain(required);
        }
    });

    it('includes every language configuration, grammar and snippet declared in the archived manifest', async () => {
        const { stdout } = await promisify(execFile)('unzip', ['-p', VSIX_PATH, 'extension/package.json']);
        const manifest = JSON.parse(stdout);
        const contributedPaths: string[] = [
            ...manifest.contributes.languages.map((language: { configuration: string }) => language.configuration),
            ...manifest.contributes.grammars.map((grammar: { path: string }) => grammar.path),
            ...manifest.contributes.snippets.map((snippet: { path: string }) => snippet.path),
        ];
        for (const assetPath of contributedPaths) {
            expect(files).toContain(assetPath.replace(/^\.\//, ''));
        }
    });

    it('excludes sources, build artifacts and legacy indexer leftovers', () => {
        const offenders = files.filter((file) =>
            file.startsWith('src/')
            || file.startsWith('lapligence/')
            || file.startsWith('softbrush/')
            || file.startsWith('node_modules/')
            || file.endsWith('.map')
            || file.endsWith('.ts')
            || file.includes('worker.js')
            || file.includes('ctags'));
        expect(offenders).toEqual([]);
    });

    it('bundles executable-size linux-x64 server binary entries', () => {
        for (const binary of ['llg_ls', 'softbrush_ls']) {
            const packagedPath = `server/linux-x64/${binary}`;
            expect(files).toContain(packagedPath);

            const archivePath = `extension/${packagedPath}`;
            const server = servers.get(archivePath);
            expect(server, `missing zip metadata for ${archivePath}`).toBeDefined();
            expect(server?.size).toBeGreaterThan(1024);
            expect(server?.executable).toBe(true);

            const stat = fs.statSync(path.join(REPO_ROOT, packagedPath));
            expect(stat.size).toBeGreaterThan(1024);
            expect(stat.mode & 0o111).not.toBe(0);
            expect(server?.size).toBe(stat.size);
        }
    });
});
