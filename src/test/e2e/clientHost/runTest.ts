// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { runTests, type TestOptions } from '@vscode/test-electron';

import { createWorkspaceFixture } from '../fixtures/workspace';
import { persistDiagnosticDirectory, persistDiagnosticFiles } from '../../support/artifacts';
import { requireDisplayForGuiTest } from '../../support/display';
import { VSCODE_DOWNLOAD_TIMEOUT_MS } from '../../support/vscodeDownload';
import { terminateProcessTree, terminateRecordedProcesses } from '../../support/process';

// Keep the pure display policy available from its historical client-host test
// module while the actual probe is shared with the Playwright desktop runner.
export { decideDisplayPreflight } from '../../support/display';
export type { DisplayEndpoint, DisplayPreflightDecision } from '../../support/display';

function findRepoRoot(startDir: string): string {
    let dir = path.resolve(startDir);
    for (;;) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`could not locate the repository root starting at ${startDir}`);
        }
        dir = parent;
    }
}

const REPO_ROOT = findRepoRoot(__dirname);

/** Compiled artifacts emitted by `npm run compile-tests` (tsc --outDir out). */
const COMPILED_FAKE_SERVER = path.join(REPO_ROOT, 'out', 'test', 'e2e', 'clientHost', 'suite', 'fakeLspServer.js');
const COMPILED_TEST_SUITE = path.join(REPO_ROOT, 'out', 'test', 'e2e', 'clientHost', 'suite', 'index.js');
const VSCODE_CACHE_ENV = 'HDLSUPPORT_E2E_VSCODE_CACHE';
const VSCODE_EXECUTABLE_ENV = 'HDLSUPPORT_VSCODE_EXECUTABLE';
const HOST_WORKER_ARGUMENT = '--hdlsupport-client-host-worker';
const HOST_WORKER_TIMEOUT_MS = 180_000;

function hostTestOptions(baseDir: string, projectDir: string): TestOptions {
    const controlDir = path.join(baseDir, 'control');
    const recordPath = path.join(baseDir, 'recorded-initialize.json');
    const fakeLogPath = path.join(controlDir, 'fake-server.log');
    const userDataDir = path.join(baseDir, 'user-data');
    const configuredExecutable = process.env[VSCODE_EXECUTABLE_ENV]?.trim();
    if (configuredExecutable !== undefined && configuredExecutable !== '' && !path.isAbsolute(configuredExecutable)) {
        throw new Error(`${VSCODE_EXECUTABLE_ENV} must be an absolute executable path`);
    }
    const configuredCache = process.env[VSCODE_CACHE_ENV]?.trim();

    return {
        version: process.env.HDLSUPPORT_E2E_VSCODE_VERSION?.trim() || 'stable',
        timeout: VSCODE_DOWNLOAD_TIMEOUT_MS,
        ...(configuredExecutable === undefined || configuredExecutable === ''
            ? {}
            : { vscodeExecutablePath: path.resolve(configuredExecutable) }),
        ...(configuredCache === undefined || configuredCache === ''
            ? {}
            : { cachePath: path.resolve(configuredCache) }),
        extensionDevelopmentPath: REPO_ROOT,
        extensionTestsPath: COMPILED_TEST_SUITE,
        launchArgs: [
            ...(process.env.HDLSUPPORT_E2E_DISABLE_GPU === '1'
                ? ['--disable-gpu', '--disable-dev-shm-usage']
                : []),
            '--disable-extensions',
            `--user-data-dir=${userDataDir}`,
            `--extensions-dir=${path.join(baseDir, 'extensions')}`,
            projectDir,
        ],
        extensionTestsEnv: {
            LLG_FAKE_RECORD: recordPath,
            LLG_FAKE_CONTROL_DIR: controlDir,
            LLG_FAKE_LOG: fakeLogPath,
            HDLSUPPORT_E2E_EXPLORER: '1',
            HDLSUPPORT_TEST_MODE: '1',
            HDLSUPPORT_TEST_NODE_EXECUTABLE: process.execPath,
            HDLSUPPORT_TEST_SERVER_MODULE: path.resolve(COMPILED_FAKE_SERVER),
        },
    };
}

async function runHostTestsInWorker(baseDir: string, projectDir: string): Promise<void> {
    const exitCode = await runTests(hostTestOptions(baseDir, projectDir));
    if (exitCode !== 0) {
        throw new Error(`@vscode/test-electron exited with code ${exitCode}`);
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
        const timeout = setTimeout(() => finish({
            code: null,
            signal: null,
            timedOut: true,
        }), HOST_WORKER_TIMEOUT_MS);
        child.once('error', (error) => finish({
            code: null,
            signal: null,
            error,
        }));
        child.once('exit', (code, signal) => finish({ code, signal }));
    });
}

async function runHostTestsWithTimeout(baseDir: string, projectDir: string): Promise<void> {
    const workerArguments = __filename.endsWith('.ts')
        ? [
            '-r',
            require.resolve('ts-node/register/transpile-only'),
            __filename,
            HOST_WORKER_ARGUMENT,
            baseDir,
            projectDir,
        ]
        : [__filename, HOST_WORKER_ARGUMENT, baseDir, projectDir];
    const worker = spawn(process.execPath, workerArguments, {
        cwd: REPO_ROOT,
        env: process.env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: 'inherit',
    });
    if (worker.pid === undefined) {
        throw new Error('client-host worker did not expose a PID');
    }

    const result = await waitForWorker(worker);
    if (result.timedOut) {
        const stopped = await terminateProcessTree(worker.pid, {
            timeoutMs: 10_000,
            processGroup: process.platform !== 'win32',
            onWarning: (message) => console.warn(`[clientHost] ${message}`),
        });
        const timeoutError = new Error(
            `client-host worker exceeded its ${HOST_WORKER_TIMEOUT_MS}ms timeout`,
        );
        if (!stopped) {
            throw new AggregateError([
                timeoutError,
                new Error(`client-host worker process ${worker.pid} could not be confirmed dead`),
            ], 'client-host worker timed out and cleanup failed');
        }
        throw timeoutError;
    }
    if (result.error) {
        throw result.error;
    }
    if (result.code !== 0) {
        throw new Error(
            `client-host worker exited with ${result.signal === null ? `code ${result.code}` : `signal ${result.signal}`}`,
        );
    }
}

export async function run(): Promise<void> {
    await requireDisplayForGuiTest('clientHost');

    // Fresh fixture workspace per invocation; the fake server + control files
    // live next to it so everything is cleaned up together afterwards. macOS
    // limits socket paths to 103 characters and VS Code creates
    // <user-data-dir>/<version>-main.sock, so keep the directory name short.
    const fixture = createWorkspaceFixture('hdl-e2e');
    const userDataDir = path.join(fixture.baseDir, 'user-data');
    let testFailed = false;
    let testError: unknown;
    try {
        const controlDir = path.join(fixture.baseDir, 'control');
        fs.mkdirSync(controlDir, { recursive: true });
        fs.writeFileSync(path.join(controlDir, 'mode'), 'normal');

        // Recent VS Code builds open a Chat view whose input box is a code
        // editor; when it keeps focus, editor commands such as commentLine and
        // default:type act on it instead of the test document.
        fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
        fs.writeFileSync(
            path.join(userDataDir, 'User', 'settings.json'),
            `${JSON.stringify({ 'chat.disableAIFeatures': true }, null, 2)}\n`,
        );
        fs.mkdirSync(path.join(fixture.projectDir, '.vscode'), { recursive: true });
        fs.writeFileSync(
            path.join(fixture.projectDir, '.vscode', 'settings.json'),
            `${JSON.stringify({ 'hdlsupport.llg.path': process.execPath }, null, 2)}\n`,
        );

        await runHostTestsWithTimeout(fixture.baseDir, fixture.projectDir);
    } catch (error) {
        testFailed = true;
        testError = error;
        console.error('[clientHost] electron test host failed:', error);
    }

    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
        persistDiagnosticFiles('client-host', [
            { name: 'recorded-initialize.json', path: path.join(fixture.baseDir, 'recorded-initialize.json') },
            { name: 'fake-server.log', path: path.join(fixture.baseDir, 'control', 'fake-server.log') },
            { name: 'launches.log', path: path.join(fixture.baseDir, 'control', 'launches.log') },
            { name: 'server.pid', path: path.join(fixture.baseDir, 'control', 'server.pid') },
            { name: 'module-explorer.json', path: path.join(fixture.baseDir, 'control', 'module-explorer.json') },
        ]);
        // VS Code writes extension-host and renderer diagnostics below the
        // isolated user-data directory. Copy them before fixture.dispose().
        persistDiagnosticDirectory('client-host', 'vscode-user-data', userDataDir);
        const failures = await terminateRecordedProcesses(path.join(fixture.baseDir, 'control'), {
            onWarning: (message) => console.warn(`[clientHost] ${message}`),
        });
        if (failures.length > 0) {
            cleanupFailed = true;
            cleanupError = new Error(
                `client-host cleanup left live fake-server process(es): ${failures.join(', ')}`,
            );
        }
    } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
    } finally {
        try {
            fixture.dispose();
        } catch (error) {
            cleanupFailed = true;
            cleanupError = cleanupError === undefined
                ? error
                : new AggregateError([cleanupError, error], 'client-host cleanup failed');
        }
    }

    if (testFailed && cleanupFailed) {
        throw new AggregateError([testError, cleanupError], 'client-host test and cleanup failed');
    }
    if (cleanupFailed) {
        throw cleanupError;
    }
    if (testFailed) {
        throw testError;
    }
}

if (require.main === module) {
    const workerArgumentIndex = process.argv.indexOf(HOST_WORKER_ARGUMENT);
    const workerMode = workerArgumentIndex >= 0;
    const operation = workerMode
        ? runHostTestsInWorker(process.argv[workerArgumentIndex + 1] ?? '', process.argv[workerArgumentIndex + 2] ?? '')
        : run();
    operation.catch((error: unknown) => {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exitCode = 1;
    });
}
