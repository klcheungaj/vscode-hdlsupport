#!/usr/bin/env node
// Packages a platform-specific VSIX: stages both pinned language servers for
// one VS Code target and runs `vsce package --target <target>`, producing
// hdl-support-<target>.vsix in the repository root.
//
// Usage: ts-node scripts/package-target.ts [--target <t>]   (default: this host's target)

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { stageRelease, targetFromArgv } from './serverRelease';
import { LLG_RELEASE } from './stage-server';
import { SOFTBRUSH_RELEASE } from './stage-softbrush';

const repoRoot = resolve(__dirname, '..');

async function packageTarget(): Promise<void> {
  const target = targetFromArgv(process.argv);
  await stageRelease(LLG_RELEASE, target);
  await stageRelease(SOFTBRUSH_RELEASE, target);

  const vsce = join(dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
  const out = `hdl-support-${target}.vsix`;
  const result = spawnSync(process.execPath, [vsce, 'package', '--target', target, '--out', out], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`vsce package for ${target} failed: ${result.error?.message ?? result.status}`);
  }
}

packageTarget().catch((error: unknown) => {
  console.error(`package-target: error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
