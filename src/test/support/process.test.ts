// SPDX-License-Identifier: MIT

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    isProcessAlive,
    readRecordedPids,
    terminateProcessTree,
    terminateRecordedProcesses,
    windowsProcessTreeScript,
} from './process';

const children: ChildProcess[] = [];
const temporaryDirectories: string[] = [];

async function spawnLongLivedChild(): Promise<ChildProcess> {
    const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => undefined, 60_000);'],
        { stdio: 'ignore' },
    );
    children.push(child);
    await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
    });
    return child;
}

async function waitForExit(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
    });
}

afterEach(async () => {
    for (const child of children.splice(0)) {
        if (child.pid !== undefined && isProcessAlive(child.pid)) {
            await terminateProcessTree(child.pid, { timeoutMs: 2_000, pollIntervalMs: 10 });
        }
        if (child.pid !== undefined && isProcessAlive(child.pid)) {
            child.kill('SIGKILL');
        }
        await waitForExit(child);
    }
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

describe('process cleanup helpers', () => {
    it('reports true after terminating an existing process on every supported host', async () => {
        // Arrange
        const child = await spawnLongLivedChild();
        expect(child.pid).toBeDefined();

        // Act
        const terminated = await terminateProcessTree(child.pid as number, {
            timeoutMs: 2_000,
            pollIntervalMs: 10,
        });

        // Assert
        expect(terminated).toBe(true);
        expect(isProcessAlive(child.pid as number)).toBe(false);
    });

    it.runIf(process.platform === 'linux')(
        'treats unreaped zombies as dead so a process group of zombies counts as cleaned',
        async () => {
            // Arrange: `exec sleep` replaces the shell, so nothing reaps the
            // background child and it stays a zombie in the detached group.
            const leader = spawn('sh', ['-c', 'true & echo $!; exec sleep 30'], {
                detached: true,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            children.push(leader);
            const zombiePid = await new Promise<number>((resolve, reject) => {
                leader.stdout?.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
                leader.once('error', reject);
            });
            const deadline = Date.now() + 2_000;
            while (!fs.readFileSync(`/proc/${zombiePid}/stat`, 'utf8').includes(') Z ') && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(fs.readFileSync(`/proc/${zombiePid}/stat`, 'utf8')).toContain(') Z ');

            // Act
            const zombieAlive = isProcessAlive(zombiePid);
            const terminated = await terminateProcessTree(leader.pid as number, {
                timeoutMs: 2_000,
                pollIntervalMs: 10,
                processGroup: true,
            });

            // Assert
            expect(zombieAlive).toBe(false);
            expect(terminated).toBe(true);
        },
    );

    it('cleans recorded live processes without reporting a false failure', async () => {
        // Arrange
        const child = await spawnLongLivedChild();
        const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdlsupport-process-test-'));
        temporaryDirectories.push(controlDir);
        fs.writeFileSync(path.join(controlDir, 'server.pid'), String(child.pid));
        fs.writeFileSync(path.join(controlDir, 'launches.log'), `${child.pid} launch\n`);

        // Act
        const failures = await terminateRecordedProcesses(controlDir, {
            timeoutMs: 2_000,
            pollIntervalMs: 10,
        });

        // Assert
        expect(failures).toEqual([]);
        expect(isProcessAlive(child.pid as number)).toBe(false);
    });

    it('writes the root PID into the Windows tree script instead of relying on $args', () => {
        // `powershell -Command <script> <pid>` leaves $args empty, which made the root 0
        // and listed the System processes as descendants.
        const script = windowsProcessTreeScript(4242);

        expect(script).toContain('$root = 4242;');
        expect(script).not.toContain('$args');
    });

    it('returns the current PID first and historical launch PIDs newest first', () => {
        // Arrange
        const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdlsupport-pids-test-'));
        temporaryDirectories.push(controlDir);
        fs.writeFileSync(path.join(controlDir, 'server.pid'), '202\n');
        fs.writeFileSync(
            path.join(controlDir, 'launches.log'),
            '101 2026-01-01T00:00:00.000Z\n'
            + '202 2026-01-01T00:00:01.000Z\n'
            + '303 2026-01-01T00:00:02.000Z\n'
            + 'not-a-pid\n'
            + '0 ignored\n',
        );

        // Act
        const pids = readRecordedPids(controlDir);

        // Assert
        expect(pids).toEqual([202, 303, 101]);
    });

    it('ignores an absent control directory and malformed PID files', () => {
        // Arrange / Act / Assert
        expect(readRecordedPids('')).toEqual([]);
        expect(readRecordedPids('/tmp/hdlsupport-process-test-does-not-exist')).toEqual([]);
    });
});
