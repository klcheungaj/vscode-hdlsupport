// Shared helper for staging a prebuilt language-server binary from a pinned
// GitHub release; the servers are never built from source in this repo.
//
// The archive is downloaded once into node_modules/.cache/hdl-support-servers/,
// verified against the SHA-256 pinned in the calling script (never against a
// checksum fetched alongside it), extracted into a fresh temporary directory,
// and the single executable member is stripped and atomically renamed into
// server/linux-x64/.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

export interface ServerRelease {
  /** Short name used as the log prefix, e.g. `stage-server`. */
  label: string;
  /** GitHub `owner/repo`. */
  repo: string;
  /** Release tag, e.g. `v0.1.0`. */
  tag: string;
  /** Release asset file name (a `.tar.gz`). */
  asset: string;
  /** Lower-case hex SHA-256 of the asset. */
  sha256: string;
  /** Archive member to stage; also the staged file name. */
  binary: string;
}

const repoRoot = resolve(__dirname, '..');
const cacheDir = join(repoRoot, 'node_modules', '.cache', 'hdl-support-servers');
const MIN_BINARY_BYTES = 100_000;

function downloadUrl(release: ServerRelease): string {
  return `https://github.com/${release.repo}/releases/download/${release.tag}/${release.asset}`;
}

function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function fetchArchive(release: ServerRelease, log: (message: string) => void): Promise<string> {
  const cached = join(cacheDir, release.tag, release.asset);
  if (existsSync(cached) && sha256Of(cached) === release.sha256) {
    log(`using cached ${relative(repoRoot, cached)}`);
    return cached;
  }

  const url = downloadUrl(release);
  log(`downloading ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download of ${url} failed: HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== release.sha256) {
    throw new Error(`checksum mismatch for ${release.asset}: expected ${release.sha256}, got ${actual}`);
  }

  mkdirSync(dirname(cached), { recursive: true });
  const temporary = `${cached}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, cached);
  log(`verified ${release.asset} (sha256 ${actual})`);
  return cached;
}

export function printPlan(release: ServerRelease): void {
  const destination = join(repoRoot, 'server', 'linux-x64', release.binary);
  console.log(
    JSON.stringify(
      {
        url: downloadUrl(release),
        sha256: release.sha256,
        member: release.binary,
        cache: relative(repoRoot, join(cacheDir, release.tag, release.asset)),
        destination: relative(repoRoot, destination),
      },
      null,
      2,
    ),
  );
}

export async function stageRelease(release: ServerRelease): Promise<void> {
  const log = (message: string): void => console.log(`${release.label}: ${message}`);
  const destination = join(repoRoot, 'server', 'linux-x64', release.binary);
  const archive = await fetchArchive(release, log);

  const extractDir = mkdtempSync(join(tmpdir(), `${release.label}-`));
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    const tar = spawnSync('tar', ['-xzf', archive, '-C', extractDir, release.binary], { stdio: 'inherit' });
    if (tar.error || tar.status !== 0) {
      throw new Error(`extracting ${release.binary} from ${release.asset} failed: ${tar.error?.message ?? tar.status}`);
    }
    const extracted = join(extractDir, release.binary);
    if (!existsSync(extracted) || statSync(extracted).size < MIN_BINARY_BYTES) {
      throw new Error(`${release.asset} does not contain a usable ${release.binary}`);
    }

    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(extracted, temporary);
    chmodSync(temporary, 0o755);
    const strip = spawnSync('strip', [temporary], { stdio: 'inherit' });
    if (strip.error || strip.status !== 0) {
      console.warn(`${release.label}: warning: strip unavailable or failed; keeping the unstripped binary.`);
    }
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  }

  const size = (statSync(destination).size / (1024 * 1024)).toFixed(1);
  log(`staged ${relative(repoRoot, destination)} (${size} MiB) from ${release.repo}@${release.tag}`);
}

export function main(release: ServerRelease): void {
  if (process.argv.includes('--print-plan')) {
    printPlan(release);
    return;
  }
  stageRelease(release).catch((error: unknown) => {
    console.error(`${release.label}: error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
