// SPDX-License-Identifier: MIT
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { executeFile } from '../../linter/processExecution';

describe('Windows batch process execution', () => {
  it.runIf(process.platform === 'win32')('resolves a command through PATHEXT and preserves literal arguments', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hdl-support-batch-'));
    const script = path.join(directory, 'capture.js');
    const launcher = path.join(directory, 'capture-args.cmd');
    try {
      await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
      await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
      const args = ['spaced value', 'A&B', '%PATH%', '$(literal)'];
      const environment: NodeJS.ProcessEnv = { ...process.env };
      environment['PATH'] = `${directory}${path.delimiter}${process.env.PATH ?? ''}`;
      environment['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';
      const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
        executeFile('capture-args', args, {
          cwd: directory,
          env: environment,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
      });

      expect(result.error).toBeNull();
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
