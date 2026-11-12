// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { runTests, type TestOptions } from '@vscode/test-electron';

import { persistDiagnosticDirectory } from '../../../support/artifacts';
import { requireDisplayForGuiTest } from '../../../support/display';
import { terminateProcessTree } from '../../../support/process';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const COMPILED_SUITE = path.join(__dirname, 'realSoftbrushHostIndex.js');
const SERVER_PATH = path.join(REPO_ROOT, 'server', 'linux-x64', 'softbrush_ls');
const HOST_WORKER_ARGUMENT = '--hdlsupport-real-softbrush-host-worker';
const HOST_WORKER_TIMEOUT_MS = 180_000;
const SDC_TEXT = [
    'acme_set_clock_latency -corner fast [get_clocks sys_clk]',
    'create_clock -name sys_clk -period 10 [get_ports clk]',
    '',
].join('\n');
const TCL_TEXT = [
    '# Softbrush host contract',
    'proc scale {value} { return $value }',
    'set count 42',
    '',
].join('\n');
const XDC_TEXT = [
    'acme_route_clock -region north [get_nets sys_clk]',
    'create_clock -name sys_clk -period 10 [get_ports clk]',
    '',
].join('\n');

function hostOptions(baseDir: string, projectDir: string, sourcePath: string): TestOptions {
    const configuredExecutable = process.env.HDLSUPPORT_VSCODE_EXECUTABLE?.trim();
    const configuredCache = process.env.HDLSUPPORT_E2E_VSCODE_CACHE?.trim();
    if (configuredExecutable && !path.isAbsolute(configuredExecutable)) {
        throw new Error('HDLSUPPORT_VSCODE_EXECUTABLE must be an absolute executable path');
    }
    if (configuredCache && !path.isAbsolute(configuredCache)) {
        throw new Error('HDLSUPPORT_E2E_VSCODE_CACHE must be an absolute directory path');
    }
    return {
        version: process.env.HDLSUPPORT_E2E_VSCODE_VERSION?.trim() || 'stable',
        ...(configuredExecutable ? { vscodeExecutablePath: path.resolve(configuredExecutable) } : {}),
        ...(configuredCache ? { cachePath: path.resolve(configuredCache) } : {}),
        extensionDevelopmentPath: REPO_ROOT,
        extensionTestsPath: COMPILED_SUITE,
        launchArgs: [
            ...(process.env.HDLSUPPORT_E2E_DISABLE_GPU === '1'
                ? ['--disable-gpu', '--disable-dev-shm-usage']
                : []),
            '--disable-extensions',
            `--user-data-dir=${path.join(baseDir, 'user-data')}`,
            `--extensions-dir=${path.join(baseDir, 'extensions')}`,
            projectDir,
        ],
        extensionTestsEnv: {
            HDLSUPPORT_TEST_MODE: '0',
            HDLSUPPORT_REAL_SOFTBRUSH_SOURCE: sourcePath,
        },
    };
}

interface WorkerExit {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error?: Error;
    readonly timedOut?: boolean;
}

function waitForWorker(child: ChildProcess): Promise<WorkerExit> {
    return new Promise<WorkerExit>((resolve) => {
        let settled = false;
        const finish = (result: WorkerExit): void => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };
        const timeout = setTimeout(() => finish({ code: null, signal: null, timedOut: true }), HOST_WORKER_TIMEOUT_MS);
        child.once('error', (error) => finish({ code: null, signal: null, error }));
        child.once('exit', (code, signal) => finish({ code, signal }));
    });
}

async function runWorker(baseDir: string, projectDir: string, sourcePath: string): Promise<void> {
    const exitCode = await runTests(hostOptions(baseDir, projectDir, sourcePath));
    if (exitCode !== 0) {
        throw new Error(`real-Softbrush host probe exited with code ${exitCode}`);
    }
}

async function runWithTimeout(baseDir: string, projectDir: string, sourcePath: string): Promise<void> {
    const worker = spawn(process.execPath, [
        __filename,
        HOST_WORKER_ARGUMENT,
        baseDir,
        projectDir,
        sourcePath,
    ], {
        cwd: REPO_ROOT,
        env: process.env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: 'inherit',
    });
    if (worker.pid === undefined) {
        throw new Error('real-Softbrush client-host worker did not expose a PID');
    }
    const result = await waitForWorker(worker);
    const cleaned = await terminateProcessTree(worker.pid, {
        timeoutMs: 10_000,
        processGroup: process.platform !== 'win32',
        onWarning: (message) => console.warn(`[real-softbrush-host] ${message}`),
    });
    if (!cleaned) {
        throw new Error(`worker process group ${worker.pid} could not be confirmed dead`);
    }
    if (result.timedOut) {
        throw new Error(`real-Softbrush client-host worker exceeded ${HOST_WORKER_TIMEOUT_MS}ms`);
    }
    if (result.error) { throw result.error; }
    if (result.code !== 0) {
        throw new Error(
            `real-Softbrush client-host worker exited with ${result.signal === null ? `code ${result.code}` : `signal ${result.signal}`}`,
        );
    }
}

async function run(): Promise<void> {
    await requireDisplayForGuiTest('real-softbrush-host');
    fs.accessSync(SERVER_PATH, fs.constants.X_OK);
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdlsupport-real-softbrush-host-'));
    const projectDir = path.join(baseDir, 'project');
    const sourcePath = path.join(projectDir, 'constraints.sdc');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(sourcePath, SDC_TEXT);
    fs.writeFileSync(path.join(projectDir, 'script.tcl'), TCL_TEXT);
    fs.writeFileSync(path.join(projectDir, 'pins.xdc'), XDC_TEXT);
    let testError: unknown;
    try {
        await runWithTimeout(baseDir, projectDir, sourcePath);
    } catch (error) {
        testError = error;
    } finally {
        persistDiagnosticDirectory('real-softbrush-host', 'vscode-user-data', path.join(baseDir, 'user-data'));
        try {
            fs.rmSync(baseDir, { recursive: true, force: true });
        } catch (cleanupError) {
            if (testError !== undefined) {
                throw new AggregateError([testError, cleanupError], 'real-Softbrush probe and cleanup failed');
            }
            throw cleanupError;
        }
    }
    if (testError !== undefined) { throw testError; }
}

if (require.main === module) {
    const workerArgumentIndex = process.argv.indexOf(HOST_WORKER_ARGUMENT);
    const operation = workerArgumentIndex >= 0
        ? runWorker(
            process.argv[workerArgumentIndex + 1] ?? '',
            process.argv[workerArgumentIndex + 2] ?? '',
            process.argv[workerArgumentIndex + 3] ?? '',
        )
        : run();
    operation.catch((error: unknown) => {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exitCode = 1;
    });
}

export { run };
