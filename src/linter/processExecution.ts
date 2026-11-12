// SPDX-License-Identifier: MIT
import * as child from 'child_process';
import { stat } from 'fs/promises';
import * as path from 'path';
import crossSpawn from 'cross-spawn';

export type CommandCallback = (
  error: child.ExecFileException | null,
  stdout: string,
  stderr: string
) => void;

const DEFAULT_MAX_BUFFER = 1024 * 1024;

function commandError(
  message: string,
  code: string | number,
  killed: boolean,
  signal: NodeJS.Signals | null
): child.ExecFileException {
  return Object.assign(new Error(message), { code, killed, signal }) as child.ExecFileException;
}

/** Terminates the full command tree on Windows, where batch launchers often create child processes. */
export function terminateProcess(
  processToTerminate: child.ChildProcess,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'win32' || processToTerminate.pid === undefined) {
    processToTerminate.kill();
    return;
  }
  try {
    child.execFile(
      'taskkill',
      ['/PID', String(processToTerminate.pid), '/T', '/F'],
      { windowsHide: true, shell: false },
      error => {
        if (error) {
          processToTerminate.kill();
        }
      }
    );
  } catch {
    processToTerminate.kill();
  }
}

/**
 * The executable for a tool: the configured path, the default executable inside
 * a configured directory, or the default name looked up on PATH when unset.
 */
export async function resolveExecutable(configured: string, defaultExecutable: string): Promise<string> {
  const executable = configured.trim();
  if (!executable) {
    return defaultExecutable;
  }
  const info = await stat(executable).catch(() => undefined);
  return info?.isDirectory() ? path.join(executable, defaultExecutable) : executable;
}

export interface ExecuteFileOptions extends child.ExecFileOptions {
  /** Text written to the command's stdin, which is then closed. */
  input?: string;
}

/**
 * Executes an argv-based command without a user-controlled shell.
 *
 * Windows needs cross-spawn so commands resolved through PATHEXT to batch files
 * receive the same safe argument escaping as native executables.
 */
export function executeFile(
  command: string,
  args: readonly string[],
  options: ExecuteFileOptions,
  callback: CommandCallback,
  platform: NodeJS.Platform = process.platform
): child.ChildProcess {
  const { input, ...execOptions } = options;
  const writeInput = (started: child.ChildProcess): child.ChildProcess => {
    if (input !== undefined) {
      // A command that exits before reading its input reports through its exit status.
      started.stdin?.on('error', () => undefined);
      started.stdin?.end(input);
    }
    return started;
  };
  if (platform !== 'win32') {
    return writeInput(child.execFile(command, args, { ...execOptions, encoding: 'utf8', shell: false }, callback));
  }

  const { timeout = 0, maxBuffer = DEFAULT_MAX_BUFFER, encoding: _encoding, ...spawnOptions } = execOptions;
  const spawned = crossSpawn(command, args, {
    ...spawnOptions,
    shell: false,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: false,
  });
  writeInput(spawned);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutLength = 0;
  let stderrLength = 0;
  let completed = false;
  let timer: NodeJS.Timeout | undefined;

  const output = (): [string, string] => [
    Buffer.concat(stdoutChunks, stdoutLength).toString('utf8'),
    Buffer.concat(stderrChunks, stderrLength).toString('utf8'),
  ];
  const finish = (error: child.ExecFileException | null): void => {
    if (completed) {
      return;
    }
    completed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    const [stdout, stderr] = output();
    callback(error, stdout, stderr);
  };
  const collect = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
    if (completed) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const chunks = stream === 'stdout' ? stdoutChunks : stderrChunks;
    const length = stream === 'stdout' ? stdoutLength : stderrLength;
    const remaining = Math.max(0, maxBuffer - length);
    if (remaining > 0) {
      chunks.push(buffer.subarray(0, remaining));
    }
    if (stream === 'stdout') {
      stdoutLength += Math.min(buffer.length, remaining);
    } else {
      stderrLength += Math.min(buffer.length, remaining);
    }
    if (buffer.length > remaining) {
      terminateProcess(spawned, platform);
      finish(commandError(`${stream} maxBuffer length exceeded`, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', true, null));
    }
  };

  spawned.stdout?.on('data', chunk => collect('stdout', chunk));
  spawned.stderr?.on('data', chunk => collect('stderr', chunk));
  spawned.once('error', error => finish(error as child.ExecFileException));
  spawned.once('close', (code, signal) => {
    const error = code === 0
      ? null
      : commandError(`Command failed with exit code ${String(code)}`, code ?? 'UNKNOWN', signal !== null, signal);
    finish(error);
  });
  if (timeout > 0) {
    timer = setTimeout(() => {
      terminateProcess(spawned, platform);
      finish(commandError(`Command timed out after ${timeout}ms`, 'ETIMEDOUT', true, null));
    }, timeout);
  }
  return spawned;
}
