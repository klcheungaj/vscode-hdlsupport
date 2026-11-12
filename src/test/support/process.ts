// SPDX-License-Identifier: MIT

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export interface TerminateProcessOptions {
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    /** Set when the process was launched as a detached POSIX process group. */
    readonly processGroup?: boolean;
    readonly onWarning?: (message: string) => void;
}

/** Returns the PIDs that could not be confirmed dead after bounded cleanup. */
export type ProcessCleanupFailures = readonly number[];

/** Returns whether a process still exists, including when this process lacks permission to signal it. */
export function isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'EPERM' || code === 'EACCES';
    }
    return readLinuxProcStat(pid)?.state !== 'Z';
}

interface LinuxProcStat {
    readonly state: string;
    readonly pgid: number;
}

/**
 * Reads the state and process group from `/proc/<pid>/stat` on Linux.
 * Signal 0 succeeds for zombies, which an init that never reaps (e.g. a
 * container whose PID 1 is `sleep`) keeps forever even though they have
 * exited and cannot be killed. Returns undefined off Linux or when the
 * entry is gone or unreadable.
 */
function readLinuxProcStat(pid: number): LinuxProcStat | undefined {
    if (process.platform !== 'linux') {
        return undefined;
    }
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // `comm` is parenthesized and may contain spaces or ')'.
        const [state, , pgid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return { state, pgid: Number(pgid) };
    } catch {
        return undefined;
    }
}

/**
 * Terminates one process and its descendants without relying on a POSIX
 * signal implementation on Windows. The fake server is normally shut down
 * through LSP first; this is the bounded cleanup fallback for failed hosts.
 */
export async function terminateProcessTree(
    pid: number,
    options: TerminateProcessOptions = {},
): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
        return true;
    }
    const leaderAlive = isProcessAlive(pid);
    const groupAlive = options.processGroup === true && isProcessGroupAlive(pid);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    let windowsTree: WindowsProcessTree | undefined;
    if (process.platform === 'win32') {
        windowsTree = await readWindowsProcessTree(pid, timeoutMs, options.onWarning);
        if (!leaderAlive && windowsTree.descendants.length === 0) {
            // A failed process query cannot prove that a dead worker has no
            // surviving descendants, so report cleanup failure rather than
            // silently turning an orphan into a green test run.
            return windowsTree.complete;
        }
        if (!leaderAlive && !windowsTree.complete) {
            return false;
        }
    }
    if (!leaderAlive && !groupAlive && (process.platform !== 'win32' || windowsTree?.descendants.length === 0)) {
        return true;
    }

    let taskKillSucceeded = false;
    if (process.platform === 'win32') {
        // taskkill is a Windows system executable and accepts argv directly;
        // no shell quoting is involved even when the workspace path has spaces.
        // The explicit descendant list covers the race where the root exits
        // before taskkill can traverse its /T tree.
        const treePids = [pid, ...(windowsTree?.descendants ?? [])];
        for (const treePid of treePids) {
            if (!isProcessAlive(treePid)) {
                continue;
            }
            try {
                await execFileAsync('taskkill', ['/PID', String(treePid), '/T', '/F'], {
                    windowsHide: true,
                    // Keep the cleanup operation itself bounded as well as the
                    // liveness polling that follows it.
                    timeout: timeoutMs,
                });
                taskKillSucceeded = true;
            } catch (error) {
                if (isProcessAlive(treePid)) {
                    options.onWarning?.(`taskkill failed for process ${treePid}: ${String(error)}`);
                } else {
                    options.onWarning?.(`taskkill raced with process ${treePid} exiting`);
                }
            }
        }
    } else {
        if (options.processGroup === true) {
            requestSignal(-pid, 'SIGTERM');
        }
        requestSignal(pid, 'SIGTERM');
    }

    const exited = process.platform === 'win32'
        ? await waitForWindowsProcessTreeExit(
            [pid, ...(windowsTree?.descendants ?? [])],
            timeoutMs,
            pollIntervalMs,
        )
        : await waitForProcessExit(pid, timeoutMs, pollIntervalMs, options.processGroup === true);
    if (exited) {
        if (process.platform === 'win32' && windowsTree?.complete !== true && !taskKillSucceeded) {
            options.onWarning?.(`process ${pid} exited without a verifiable Windows tree cleanup`);
            return false;
        }
        return true;
    }

    if (process.platform !== 'win32') {
        if (options.processGroup === true) {
            requestSignal(-pid, 'SIGKILL');
        }
        requestSignal(pid, 'SIGKILL');
        if (await waitForProcessExit(pid, timeoutMs, pollIntervalMs, options.processGroup === true)) {
            return true;
        }
    }

    options.onWarning?.(`process ${pid} did not exit after cross-platform cleanup`);
    return false;
}

interface WindowsProcessTree {
    readonly complete: boolean;
    readonly descendants: number[];
}

async function readWindowsProcessTree(
    pid: number,
    timeoutMs: number,
    onWarning: ((message: string) => void) | undefined,
): Promise<WindowsProcessTree> {
    // PowerShell/CIM is present on supported Windows runners and lets us
    // retain descendant PIDs even if the root exits before taskkill starts.
    // Arguments are passed directly to powershell.exe; no shell interpolation
    // occurs for workspace paths or PIDs.
    const script = [
        '$root = [int]$args[0]',
        '$all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId)',
        '$pending = New-Object System.Collections.ArrayList',
        '[void]$pending.Add($root)',
        '$seen = @{}',
        '$seen[$root] = $true',
        'while ($pending.Count -gt 0) {',
        '  $parent = [int]$pending[0]',
        '  $pending.RemoveAt(0)',
        '  foreach ($candidate in $all) {',
        '    $child = [int]$candidate.ProcessId',
        '    if ([int]$candidate.ParentProcessId -eq $parent -and -not $seen.ContainsKey($child)) {',
        '      $seen[$child] = $true',
        '      [void]$pending.Add($child)',
        '      Write-Output $child',
        '    }',
        '  }',
        '}',
    ].join(';');
    try {
        const result = await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            script,
            String(pid),
        ], {
            windowsHide: true,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
        });
        const descendants = result.stdout
            .split(/\r?\n/)
            .map((line) => Number.parseInt(line.trim(), 10))
            .filter((candidate) => Number.isSafeInteger(candidate) && candidate > 0 && candidate !== pid);
        return { complete: true, descendants: [...new Set(descendants)] };
    } catch (error) {
        onWarning?.(`could not enumerate Windows descendants of process ${pid}: ${String(error)}`);
        return { complete: false, descendants: [] };
    }
}

async function waitForWindowsProcessTreeExit(
    pids: readonly number[],
    timeoutMs: number,
    pollIntervalMs: number,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (pids.some((candidate) => isProcessAlive(candidate))) {
        if (Date.now() >= deadline) {
            return false;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return true;
}

/** Terminates every PID recorded by the fake-server fixture, newest first. */
export async function terminateRecordedProcesses(
    controlDir: string,
    options: TerminateProcessOptions = {},
): Promise<ProcessCleanupFailures> {
    if (controlDir === '') {
        return [];
    }
    const pids = readRecordedPids(controlDir);
    const failures: number[] = [];
    for (const pid of pids) {
        if (!await terminateProcessTree(pid, options)) {
            failures.push(pid);
        }
    }
    return failures;
}

/** Reads both the current PID and historical launch PIDs from a fixture directory. */
export function readRecordedPids(controlDir: string): number[] {
    if (controlDir === '') {
        return [];
    }
    const historicalPids: number[] = [];
    const currentPid = readPidFile(path.join(controlDir, 'server.pid'));

    try {
        const launches = fs.readFileSync(path.join(controlDir, 'launches.log'), 'utf8');
        for (const line of launches.split(/\r?\n/)) {
            const match = /^\s*(\d+)\b/.exec(line);
            if (match !== null) {
                const pid = Number.parseInt(match[1], 10);
                if (Number.isSafeInteger(pid) && pid > 0) {
                    historicalPids.push(pid);
                }
            }
        }
    } catch {
        // The server may not have launched, or the fixture may already be
        // partially cleaned up. The current PID was handled above.
    }

    return [...new Set([
        ...(currentPid === null ? [] : [currentPid]),
        ...historicalPids.reverse(),
    ])];
}

function readPidFile(filePath: string): number | null {
    try {
        const pid = Number.parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
        return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

function requestSignal(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(pid, signal);
    } catch {
        // The process can exit between the liveness check and the signal.
    }
}

function isProcessGroupAlive(pid: number): boolean {
    if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(-pid, 0);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'EPERM' || code === 'EACCES';
    }
    if (process.platform !== 'linux') {
        return true;
    }
    return fs.readdirSync('/proc')
        .filter((entry) => /^\d+$/.test(entry))
        .map((entry) => readLinuxProcStat(Number(entry)))
        .some((stat) => stat !== undefined && stat.pgid === pid && stat.state !== 'Z');
}

async function waitForProcessExit(
    pid: number,
    timeoutMs: number,
    pollIntervalMs: number,
    processGroup: boolean,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (isProcessAlive(pid) || (processGroup && isProcessGroupAlive(pid))) {
        if (Date.now() >= deadline) {
            return false;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return true;
}
