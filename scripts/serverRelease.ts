// Shared helper for staging a prebuilt language-server binary from a pinned
// GitHub release; the servers are never built from source in this repo.
//
// The archive is downloaded once into node_modules/.cache/hdl-support-servers/,
// verified against the SHA-256 pinned in the calling script (never against a
// checksum fetched alongside it), extracted into a fresh temporary directory,
// and the single executable member is atomically renamed into
// server/<target>/. Staging a target removes every other target directory so
// a VSIX packaged afterwards bundles exactly one platform.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { BUNDLED_TARGETS, bundledBinaryName, type BundledTarget } from '../src/languageServer/resolve';

export interface ReleaseAsset {
  /** Release asset file name (a `.tar.gz`, or a `.zip` for Windows). */
  asset: string;
  /** Lower-case hex SHA-256 of the asset. */
  sha256: string;
}

export interface ServerRelease {
  /** Short name used as the log prefix, e.g. `stage-server`. */
  label: string;
  /** GitHub `owner/repo`. */
  repo: string;
  /** Release tag, e.g. `v0.1.0`. */
  tag: string;
  /** One pinned asset per bundled VS Code target. */
  assets: Record<BundledTarget, ReleaseAsset>;
  /** Executable base name; Windows archives hold `<binary>.exe`. */
  binary: string;
}

interface StagePlan {
  label: string;
  url: string;
  asset: string;
  sha256: string;
  member: string;
  cache: string;
  destination: string;
}

const repoRoot = resolve(__dirname, '..');
const serverDir = join(repoRoot, 'server');
const cacheDir = join(repoRoot, 'node_modules', '.cache', 'hdl-support-servers');
const MIN_BINARY_BYTES = 100_000;
export function isBundledTarget(value: string): value is BundledTarget {
  return (BUNDLED_TARGETS as readonly string[]).includes(value);
}

/** Reads `--target <target>` from argv, defaulting to this host's target. */
export function targetFromArgv(argv: readonly string[]): BundledTarget {
  const index = argv.indexOf('--target');
  const value = index === -1 ? `${process.platform}-${process.arch}` : argv[index + 1] ?? '';
  if (!isBundledTarget(value)) {
    const source = index === -1 ? 'this host' : '--target';
    throw new Error(`${source} is '${value}', but servers are only staged for ${BUNDLED_TARGETS.join(', ')}`);
  }
  return value;
}

function planFor(release: ServerRelease, target: BundledTarget): StagePlan {
  const { asset, sha256 } = release.assets[target];
  const member = bundledBinaryName(release.binary, target.split('-')[0]);
  return {
    label: release.label,
    url: `https://github.com/${release.repo}/releases/download/${release.tag}/${asset}`,
    asset,
    sha256,
    member,
    cache: join(cacheDir, release.tag, asset),
    destination: join(serverDir, target, member),
  };
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function fetchArchive(plan: StagePlan, log: (message: string) => void): Promise<string> {
  const { cache: cached, url } = plan;
  if (existsSync(cached) && sha256Of(cached) === plan.sha256) {
    log(`using cached ${relative(repoRoot, cached)}`);
    return cached;
  }

  log(`downloading ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download of ${url} failed: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== plan.sha256) {
    throw new Error(`checksum mismatch for ${plan.asset}: expected ${plan.sha256}, got ${actual}`);
  }

  mkdirSync(dirname(cached), { recursive: true });
  const temporary = `${cached}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, cached);
  log(`verified ${plan.asset} (sha256 ${actual})`);
  return cached;
}

export function printPlan(release: ServerRelease, target: BundledTarget): void {
  const plan = planFor(release, target);
  console.log(
    JSON.stringify(
      {
        url: plan.url,
        sha256: plan.sha256,
        member: plan.member,
        cache: relative(repoRoot, plan.cache),
        destination: relative(repoRoot, plan.destination),
      },
      null,
      2,
    ),
  );
}

function extractMember(archive: string, member: string, extractDir: string): void {
  // Windows' bundled bsdtar reads both formats; Git for Windows' GNU tar on
  // PATH misreads drive-letter paths, so name the system one explicitly.
  const [command, args] = process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', extractDir, member]]
    : archive.endsWith('.zip')
      ? ['unzip', ['-q', archive, member, '-d', extractDir]]
      : ['tar', ['-xzf', archive, '-C', extractDir, member]];
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`extracting ${member} from ${archive} with ${command} failed: ${result.error?.message ?? result.status}`);
  }
}

export async function stageRelease(release: ServerRelease, target: BundledTarget): Promise<void> {
  const plan = planFor(release, target);
  const log = (message: string): void => console.log(`${release.label}: ${message}`);
  const destination = plan.destination;
  const archive = await fetchArchive(plan, log);

  const extractDir = mkdtempSync(join(tmpdir(), `${release.label}-`));
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    extractMember(archive, plan.member, extractDir);
    const extracted = join(extractDir, plan.member);
    if (!existsSync(extracted) || statSync(extracted).size < MIN_BINARY_BYTES) {
      throw new Error(`${plan.asset} does not contain a usable ${plan.member}`);
    }

    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(extracted, temporary);
    chmodSync(temporary, 0o755);
    // Host binutils can only strip host-format executables, and stripping a
    // signed Mach-O breaks its code signature, so only strip on Linux.
    if (process.platform === 'linux' && target === `${process.platform}-${process.arch}`) {
      const strip = spawnSync('strip', [temporary], { stdio: 'inherit' });
      if (strip.error || strip.status !== 0) {
        console.warn(`${release.label}: warning: strip unavailable or failed; keeping the unstripped binary.`);
      }
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }

  readdirSync(serverDir)
    .filter((entry) => entry !== target && isBundledTarget(entry))
    .forEach((entry) => {
      rmSync(join(serverDir, entry), { recursive: true, force: true });
      log(`removed server/${entry}/ so only ${target} is bundled`);
    });

  const size = (statSync(destination).size / (1024 * 1024)).toFixed(1);
  log(`staged ${relative(repoRoot, destination)} (${size} MiB) from ${release.repo}@${release.tag}`);
}

export function main(release: ServerRelease): void {
  const run = async (): Promise<void> => {
    const target = targetFromArgv(process.argv);
    if (process.argv.includes('--print-plan')) {
      printPlan(release, target);
      return;
    }
    await stageRelease(release, target);
  };
  run().catch((error: unknown) => {
    console.error(`${release.label}: error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
