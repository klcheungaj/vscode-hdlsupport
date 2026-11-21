// SPDX-License-Identifier: MIT

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;
// A cold PowerShell start plus the first CIM query can take well over 10s on
// loaded CI runners; the query runs once, so a generous bound costs nothing
// when it is fast.
const WINDOWS_TREE_QUERY_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
// Slack between a recorded launch time and the process's real creation time
// (startup before the timestamp is written, clock granularity).
const LAUNCH_TIME_SLACK_MS = 30_000;

export interface TerminateProcessOptions {
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    /** Set when the process was launched as a detached POSIX process group. */
    readonly processGroup?: boolean;
    /**
     * When the process was launched. On Windows, processes created before it
     * are never treated as its descendants even if their stale
     * ParentProcessId matches a reused PID.
     */
    readonly startedAt?: Date;
    readonly onWarning?: (message: string) => void;
}

export interface RecordedLaunch {
    readonly pid: number;
    readonly startedAt?: Date;
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
        windowsTree = await readWindowsProcessTree(pid, timeoutMs, options.onWarning, options.startedAt);
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

/**
 * PowerShell script that prints every descendant PID of `pid`. `-Command` does
 * not expose trailing arguments as `$args` (the root would silently become 0
 * and list the System processes), so the PID, a validated positive integer, is
 * written into the script itself.
 *
 * Windows never updates ParentProcessId when a parent exits, and PIDs are
 * reused: boot-time csrss.exe/winlogon.exe still name their long-gone session
 * smss.exe as parent. A child is therefore only followed when it was created
 * no earlier than its parent: the parent's own CreationDate while it runs,
 * else `startedAt` (less a startup slack) for a root that already exited.
 */
export function windowsProcessTreeScript(pid: number, startedAt?: Date): string {
    const notBefore = startedAt === undefined
        ? '$null'
        : `[DateTime]::Parse('${new Date(startedAt.getTime() - LAUNCH_TIME_SLACK_MS).toISOString()}', `
            + '[Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()';
    return [
        `$root = ${pid}`,
        `$notBefore = ${notBefore}`,
        '$all = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, CreationDate)',
        '$created = @{}',
        'foreach ($entry in $all) { if ($entry.CreationDate) { $created[[int]$entry.ProcessId] = $entry.CreationDate.ToUniversalTime() } }',
        '$pending = New-Object System.Collections.ArrayList',
        '[void]$pending.Add($root)',
        '$seen = @{}',
        '$seen[$root] = $true',
        'while ($pending.Count -gt 0) {',
        '  $parent = [int]$pending[0]',
        '  $pending.RemoveAt(0)',
        '  $bound = if ($created.ContainsKey($parent)) { $created[$parent] } else { $notBefore }',
        '  foreach ($candidate in $all) {',
        '    $child = [int]$candidate.ProcessId',
        '    if ([int]$candidate.ParentProcessId -ne $parent -or $seen.ContainsKey($child)) { continue }',
        '    if ($null -ne $bound -and (-not $created.ContainsKey($child) -or $created[$child] -lt $bound)) { continue }',
        '    $seen[$child] = $true',
        '    [void]$pending.Add($child)',
        '    Write-Output $child',
        '  }',
        '}',
    ].join(';');
}

async function readWindowsProcessTree(
    pid: number,
    timeoutMs: number,
    onWarning: ((message: string) => void) | undefined,
    startedAt: Date | undefined,
): Promise<WindowsProcessTree> {
    // PowerShell/CIM is present on supported Windows runners and lets us
    // retain descendant PIDs even if the root exits before taskkill starts.
    const script = windowsProcessTreeScript(pid, startedAt);
    const queryTimeoutMs = Math.max(timeoutMs, WINDOWS_TREE_QUERY_TIMEOUT_MS);
    try {
        const result = await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            script,
        ], {
            windowsHide: true,
            timeout: queryTimeoutMs,
            maxBuffer: 1024 * 1024,
        });
        const descendants = result.stdout
            .split(/\r?\n/)
            .map((line) => Number.parseInt(line.trim(), 10))
            .filter((candidate) => Number.isSafeInteger(candidate) && candidate > 0 && candidate !== pid);
        return { complete: true, descendants: [...new Set(descendants)] };
    } catch (error) {
        const killed = error instanceof Error && 'killed' in error && error.killed === true;
        const reason = killed ? `timed out after ${queryTimeoutMs}ms` : String(error);
        onWarning?.(`could not enumerate Windows descendants of process ${pid}: ${reason}`);
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
    const failures: number[] = [];
    for (const launch of readRecordedLaunches(controlDir)) {
        if (!await terminateProcessTree(launch.pid, { ...options, startedAt: launch.startedAt })) {
            failures.push(launch.pid);
        }
    }
    return failures;
}

/** Reads both the current PID and historical launch PIDs from a fixture directory. */
export function readRecordedPids(controlDir: string): number[] {
    return readRecordedLaunches(controlDir).map((launch) => launch.pid);
}

/**
 * Recorded fake-server launches, current PID first, then history newest
 * first. `launches.log` lines are `<pid> <ISO launch time>`; the time is kept
 * when it parses.
 */
export function readRecordedLaunches(controlDir: string): RecordedLaunch[] {
    if (controlDir === '') {
        return [];
    }
    const currentPid = readPidFile(path.join(controlDir, 'server.pid'));
    let lines: string[] = [];
    try {
        lines = fs.readFileSync(path.join(controlDir, 'launches.log'), 'utf8').split(/\r?\n/);
    } catch {
        // The server may not have launched, or the fixture may already be
        // partially cleaned up. The current PID is still handled.
    }
    const history = lines
        .map((line) => /^\s*(\d+)\b\s*(\S*)/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match): RecordedLaunch => {
            const startedAt = new Date(match[2]);
            return {
                pid: Number.parseInt(match[1], 10),
                ...(Number.isNaN(startedAt.getTime()) ? {} : { startedAt }),
            };
        })
        .filter((launch) => Number.isSafeInteger(launch.pid) && launch.pid > 0)
        .reverse();
    const current = currentPid === null
        ? []
        : [history.find((launch) => launch.pid === currentPid) ?? { pid: currentPid }];
    return [...current, ...history]
        .filter((launch, index, all) => all.findIndex((other) => other.pid === launch.pid) === index);
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
