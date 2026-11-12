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
const COMPILED_SUITE = path.join(__dirname, 'realLlgHostIndex.js');
const SERVER_PATH = path.join(REPO_ROOT, 'server', 'linux-x64', 'llg_ls');
const HOST_WORKER_ARGUMENT = '--hdlsupport-real-llg-host-worker';
const HOST_WORKER_TIMEOUT_MS = 180_000;
const REAL_LLG_MODE_ENV = 'HDLSUPPORT_REAL_LLG_MODE';
const REAL_LLG_SOURCE_ENV = 'HDLSUPPORT_REAL_LLG_SOURCE';
const REAL_LLG_SECOND_SOURCE_ENV = 'HDLSUPPORT_REAL_LLG_SECOND_SOURCE';
const VALID_TEXT = [
    'module lint_probe (',
    '    input logic clk,',
    '    output logic result',
    ');',
    '    logic unused_sig;',
    '    assign result = clk;',
    'endmodule',
    '',
].join('\n');

type ProbeMode = 'folder' | 'single-file';

function hostOptions(
    baseDir: string,
    projectDir: string,
    sourcePath: string,
    secondSourcePath: string,
    mode: ProbeMode,
): TestOptions {
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
            mode === 'folder' ? projectDir : sourcePath,
        ],
        extensionTestsEnv: {
            HDLSUPPORT_TEST_MODE: '0',
            [REAL_LLG_MODE_ENV]: mode,
            [REAL_LLG_SOURCE_ENV]: sourcePath,
            [REAL_LLG_SECOND_SOURCE_ENV]: secondSourcePath,
        },
    };
}

async function runHostWorker(
    baseDir: string,
    projectDir: string,
    sourcePath: string,
    secondSourcePath: string,
    mode: ProbeMode,
): Promise<void> {
    const exitCode = await runTests(hostOptions(baseDir, projectDir, sourcePath, secondSourcePath, mode));
    if (exitCode !== 0) {
        throw new Error(`${mode} real-llg host probe exited with code ${exitCode}`);
    }
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
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve(result);
        };
        const timeout = setTimeout(() => finish({ code: null, signal: null, timedOut: true }), HOST_WORKER_TIMEOUT_MS);
        child.once('error', (error) => finish({ code: null, signal: null, error }));
        child.once('exit', (code, signal) => finish({ code, signal }));
    });
}

async function runHostWithTimeout(
    baseDir: string,
    projectDir: string,
    sourcePath: string,
    secondSourcePath: string,
    mode: ProbeMode,
): Promise<void> {
    const worker = spawn(process.execPath, [
        __filename,
        HOST_WORKER_ARGUMENT,
        baseDir,
        projectDir,
        sourcePath,
        secondSourcePath,
        mode,
    ], {
        cwd: REPO_ROOT,
        env: process.env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: 'inherit',
    });
    if (worker.pid === undefined) {
        throw new Error('real-llg client-host worker did not expose a PID');
    }

    const result = await waitForWorker(worker);
    if (result.timedOut) {
        const stopped = await terminateProcessTree(worker.pid, {
            timeoutMs: 10_000,
            processGroup: process.platform !== 'win32',
            onWarning: (message) => console.warn(`[real-llg-host] ${message}`),
        });
        const timeoutError = new Error(`real-llg client-host worker exceeded ${HOST_WORKER_TIMEOUT_MS}ms`);
        if (!stopped) {
            throw new AggregateError([
                timeoutError,
                new Error(`worker process ${worker.pid} could not be confirmed dead`),
            ], 'real-llg client-host timeout cleanup failed');
        }
        throw timeoutError;
    }
    const cleaned = await terminateProcessTree(worker.pid, {
        timeoutMs: 10_000,
        processGroup: process.platform !== 'win32',
        onWarning: (message) => console.warn(`[real-llg-host] ${message}`),
    });
    if (!cleaned) {
        const cleanupError = new Error(`worker process group ${worker.pid} could not be confirmed dead`);
        if (result.error) {
            throw new AggregateError([result.error, cleanupError], 'real-llg client-host worker and cleanup failed');
        }
        if (result.code !== 0) {
            throw new AggregateError([
                new Error(`real-llg client-host worker exited with code ${result.code}`),
                cleanupError,
            ], 'real-llg client-host worker and cleanup failed');
        }
        throw cleanupError;
    }
    if (result.error) {
        throw result.error;
    }
    if (result.code !== 0) {
        throw new Error(
            `real-llg client-host worker exited with ${result.signal === null ? `code ${result.code}` : `signal ${result.signal}`}`,
        );
    }
}

async function runProbe(mode: ProbeMode): Promise<void> {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), `hdlsupport-real-host-${mode}-`));
    const projectDir = path.join(baseDir, 'project');
    const sourcePath = path.join(projectDir, 'lint_probe.sv');
    const secondProjectDir = path.join(baseDir, 'second-project');
    const secondSourcePath = path.join(secondProjectDir, 'second_lint_probe.sv');
    fs.mkdirSync(projectDir);
    fs.mkdirSync(secondProjectDir);
    fs.writeFileSync(sourcePath, VALID_TEXT);
    fs.writeFileSync(secondSourcePath, VALID_TEXT);
    let testError: unknown;
    try {
        await runHostWithTimeout(baseDir, projectDir, sourcePath, secondSourcePath, mode);
    } catch (error) {
        testError = error;
    } finally {
        persistDiagnosticDirectory(`real-llg-host-${mode}`, 'vscode-user-data', path.join(baseDir, 'user-data'));
        try {
            fs.rmSync(baseDir, { recursive: true, force: true });
        } catch (cleanupError) {
            if (testError !== undefined) {
                throw new AggregateError([testError, cleanupError], `${mode} probe and cleanup failed`);
            }
            throw cleanupError;
        }
    }
    if (testError !== undefined) {
        throw testError;
    }
}

async function run(): Promise<void> {
    await requireDisplayForGuiTest('real-llg-host');
    fs.accessSync(SERVER_PATH, fs.constants.X_OK);
    const failures: Error[] = [];
    const requestedMode = process.env.HDLSUPPORT_REAL_LLG_ONLY?.trim();
    const modes: readonly ProbeMode[] = requestedMode === 'folder' || requestedMode === 'single-file'
        ? [requestedMode]
        : ['folder', 'single-file'];
    for (const mode of modes) {
        try {
            await runProbe(mode);
        } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} real-llg host probe(s) failed`);
    }
}

if (require.main === module) {
    const workerArgumentIndex = process.argv.indexOf(HOST_WORKER_ARGUMENT);
    const operation = workerArgumentIndex >= 0
        ? runHostWorker(
            process.argv[workerArgumentIndex + 1] ?? '',
            process.argv[workerArgumentIndex + 2] ?? '',
            process.argv[workerArgumentIndex + 3] ?? '',
            process.argv[workerArgumentIndex + 4] ?? '',
            process.argv[workerArgumentIndex + 5] as ProbeMode,
        )
        : run();
    operation.catch((error: unknown) => {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exitCode = 1;
    });
}

export { run };
