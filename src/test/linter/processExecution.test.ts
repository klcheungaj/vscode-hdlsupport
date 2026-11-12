// SPDX-License-Identifier: MIT
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as child from 'child_process';
import crossSpawn from 'cross-spawn';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { executeFile, type CommandCallback } from '../../linter/processExecution';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof child>(),
  execFile: vi.fn(),
}));

interface FakeProcess extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: Mock;
}

function fakeProcess(): FakeProcess {
  return Object.assign(new EventEmitter(), {
    pid: 1234,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

function launch(process: FakeProcess, callback: CommandCallback, options: child.ExecFileOptions = {}): void {
  (crossSpawn as unknown as Mock).mockReturnValueOnce(process);
  executeFile('xvlog', ['C:\\chip project\\top.sv', 'A&B', '%PATH%', '$(literal)'], options, callback, 'win32');
}

describe('Windows argv process execution', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('passes spaced and metacharacter arguments literally through cross-spawn', () => {
    const process = fakeProcess();
    const callback = vi.fn<CommandCallback>();
    launch(process, callback, { cwd: 'C:\\chip project' });

    expect(crossSpawn).toHaveBeenCalledWith(
      'xvlog',
      ['C:\\chip project\\top.sv', 'A&B', '%PATH%', '$(literal)'],
      expect.objectContaining({ cwd: 'C:\\chip project', shell: false, windowsVerbatimArguments: false })
    );
    process.stdout.write('ok');
    process.emit('close', 0, null);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(null, 'ok', '');
  });

  it('terminates the Windows process tree on timeout and completes once', () => {
    vi.useFakeTimers();
    const process = fakeProcess();
    const callback = vi.fn<CommandCallback>();
    launch(process, callback, { timeout: 25 });

    vi.advanceTimersByTime(25);
    expect(child.execFile).toHaveBeenCalledWith(
      'taskkill', ['/PID', '1234', '/T', '/F'],
      { windowsHide: true, shell: false }, expect.any(Function)
    );
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toMatchObject({ code: 'ETIMEDOUT', killed: true });

    process.emit('error', Object.assign(new Error('late failure'), { code: 'ENOENT' }));
    process.emit('close', 1, null);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('completes once when process launch fails before close', () => {
    const process = fakeProcess();
    const callback = vi.fn<CommandCallback>();
    launch(process, callback);
    const error = Object.assign(new Error('spawn xvlog ENOENT'), { code: 'ENOENT' });

    process.emit('error', error);
    process.emit('close', -1, null);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(error, '', '');
  });

  it('bounds each output stream by maxBuffer', () => {
    const process = fakeProcess();
    const callback = vi.fn<CommandCallback>();
    launch(process, callback, { maxBuffer: 4 });

    process.stdout.write(Buffer.from('abcde'));

    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true,
    });
    expect(callback.mock.calls[0][1]).toBe('abcd');
  });

  it('reports signal termination as a failed command', () => {
    const process = fakeProcess();
    const callback = vi.fn<CommandCallback>();
    launch(process, callback);

    process.emit('close', null, 'SIGTERM');

    expect(callback.mock.calls[0][0]).toMatchObject({ code: 'UNKNOWN', killed: true, signal: 'SIGTERM' });
  });
});
