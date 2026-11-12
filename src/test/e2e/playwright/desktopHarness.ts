// SPDX-License-Identifier: MIT

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
    type TestInfo,
} from '@playwright/test';

import { createWorkspaceFixture, type WorkspaceFixture } from '../fixtures/workspace';
import {
    persistDiagnosticDirectory,
    persistDiagnosticFiles,
    persistDiagnosticText,
} from '../../support/artifacts';
import { requireDisplayForGuiTest } from '../../support/display';
import { terminateProcessTree, terminateRecordedProcesses } from '../../support/process';

const REPO_ROOT = findRepoRoot(__dirname);
const COMPILED_FAKE_SERVER = path.resolve(
    REPO_ROOT,
    'out',
    'test',
    'e2e',
    'clientHost',
    'suite',
    'fakeLspServer.js',
);
const COMPILED_EXTENSION = path.resolve(REPO_ROOT, 'dist', 'extension.js');
const DEFAULT_VSCODE_VERSION = 'stable';
const VSCODE_CACHE_ENV = 'HDLSUPPORT_E2E_VSCODE_CACHE';
const CDP_READY_TIMEOUT_MS = 60_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;
const MAX_CAPTURED_OUTPUT = 2 * 1024 * 1024;

export interface DesktopSession {
    readonly page: Page;
    readonly fixture: WorkspaceFixture;
    readonly controlDir: string;
    /** Captures failure artifacts before cleanup removes the temporary fixture. */
    captureDiagnostics(testInfo: TestInfo): Promise<void>;
    dispose(): Promise<void>;
}

interface SessionResources {
    readonly tempRoot: string;
    readonly fixture: WorkspaceFixture;
    readonly controlDir: string;
    readonly userDataDir: string;
    readonly child: ChildProcess;
    readonly browser: Browser;
    readonly context: BrowserContext;
    readonly page: Page;
    readonly stdout: string[];
    readonly stderr: string[];
    traceActive: boolean;
    disposed: boolean;
}

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

function requireFile(filePath: string, description: string): void {
    if (!fs.existsSync(filePath)) {
        throw new Error(`${description} is missing. Build the development artifacts before running the desktop suite.`);
    }
}

async function reserveLoopbackPort(): Promise<number> {
    const server = net.createServer();
    try {
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => reject(error);
            server.once('error', onError);
            server.listen({ host: '127.0.0.1', port: 0 }, () => {
                server.removeListener('error', onError);
                resolve();
            });
        });
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('the loopback port reservation returned no TCP address');
        }
        return address.port;
    } finally {
        if (server.listening) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }
}

async function waitUntil(
    probe: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await probe()) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error(`${description} was not ready within ${timeoutMs}ms`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

async function waitForCdpOrProcessExit(child: ChildProcess, port: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
            `VS Code exited before its loopback CDP endpoint was ready `
                + `(exit=${child.exitCode ?? 'none'}, signal=${child.signalCode ?? 'none'}).`,
        );
    }
    return cdpEndpointReady(port);
}

async function waitForPage(context: BrowserContext): Promise<Page> {
    let page: Page | undefined;
    await waitUntil(
        () => {
            page = context.pages()[0];
            return page !== undefined;
        },
        'the VS Code renderer page',
        CDP_READY_TIMEOUT_MS,
    );
    return page as Page;
}

async function cdpEndpointReady(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const request = http.get({
            host: '127.0.0.1',
            port,
            path: '/json/version',
            headers: { Accept: 'application/json' },
        }, (response) => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.once('error', () => resolve(false));
        request.setTimeout(1_000, () => {
            request.destroy();
            resolve(false);
        });
    });
}

function appendCapturedOutput(target: string[], chunk: unknown): void {
    const text = String(chunk);
    const currentLength = target.reduce((total, value) => total + value.length, 0);
    if (currentLength >= MAX_CAPTURED_OUTPUT) {
        return;
    }
    target.push(text.slice(0, MAX_CAPTURED_OUTPUT - currentLength));
}

function writeUserSettings(userDataDir: string): void {
    const userDir = path.join(userDataDir, 'User');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'settings.json'), `${JSON.stringify({
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'workbench.startupEditor': 'none',
        'workbench.welcomePage.walkthroughs.openOnInstall': false,
        'workbench.tips.enabled': false,
        'security.workspace.trust.enabled': false,
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
    }, null, 2)}\n`);
}

function launchArguments(
    fixture: WorkspaceFixture,
    userDataDir: string,
    extensionsDir: string,
    cdpPort: number,
): string[] {
    return [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-gpu-sandbox',
        '--disable-dev-shm-usage',
        '--disable-updates',
        '--disable-telemetry',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        '--force-color-profile=srgb',
        '--locale=en',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        `--remote-debugging-host=127.0.0.1`,
        `--remote-debugging-port=${cdpPort}`,
        `--extensionDevelopmentPath=${REPO_ROOT}`,
        // Open the project folder so its .vscode/settings.json supplies the
        // test-only Node executable override. The journey opens top.sv after
        // the workbench is ready.
        fixture.projectDir,
    ];
}

function fixtureSettings(
    fixture: WorkspaceFixture,
    controlDir: string,
): void {
    const vscodeDir = path.join(fixture.projectDir, '.vscode');
    fs.mkdirSync(vscodeDir, { recursive: true });
    fs.writeFileSync(
        path.join(vscodeDir, 'settings.json'),
        `${JSON.stringify({ 'hdlsupport.llg.path': process.execPath }, null, 2)}\n`,
    );
    // The fixture server derives this location from LLG_FAKE_CONTROL_DIR too;
    // keeping the path explicit makes diagnostics deterministic.
    fs.writeFileSync(path.join(controlDir, 'mode'), 'normal');
}

function vscodeExecutablePath(): Promise<string> {
    const override = process.env.HDLSUPPORT_VSCODE_EXECUTABLE?.trim();
    if (override) {
        if (!path.isAbsolute(override)) {
            throw new Error('HDLSUPPORT_VSCODE_EXECUTABLE must be an absolute executable path');
        }
        return Promise.resolve(override);
    }
    const version = process.env.HDLSUPPORT_E2E_VSCODE_VERSION?.trim() || DEFAULT_VSCODE_VERSION;
    const configuredCache = process.env[VSCODE_CACHE_ENV]?.trim();
    const cachePath = configuredCache === undefined || configuredCache === ''
        ? path.join(REPO_ROOT, '.vscode-test')
        : path.resolve(configuredCache);
    return downloadAndUnzipVSCode({
        version,
        cachePath,
    });
}

function attachOutput(child: ChildProcess, stdout: string[], stderr: string[]): void {
    child.stdout?.on('data', (chunk: unknown) => appendCapturedOutput(stdout, chunk));
    child.stderr?.on('data', (chunk: unknown) => appendCapturedOutput(stderr, chunk));
    child.on('error', (error) => appendCapturedOutput(stderr, `VS Code process error: ${String(error)}\n`));
}

async function cleanupResources(resources: Partial<SessionResources>): Promise<void> {
    const child = resources.child;
    const browser = resources.browser;
    const fixture = resources.fixture;
    const tempRoot = resources.tempRoot;
    const controlDir = resources.controlDir;
    const failures: number[] = [];

    try {
        if (resources.traceActive && resources.context) {
            await resources.context.tracing.stop().catch(() => undefined);
            resources.traceActive = false;
        }
        if (browser) {
            await browser.close().catch(() => undefined);
        }
        if (child?.pid) {
            if (!await terminateProcessTree(child.pid, {
                timeoutMs: PROCESS_CLEANUP_TIMEOUT_MS,
                processGroup: process.platform !== 'win32',
                onWarning: (message) => console.warn(`[playwright] ${message}`),
            })) {
                failures.push(child.pid);
            }
        }
        if (controlDir) {
            failures.push(...await terminateRecordedProcesses(controlDir, {
                timeoutMs: PROCESS_CLEANUP_TIMEOUT_MS,
                onWarning: (message) => console.warn(`[playwright] ${message}`),
            }));
        }
    } finally {
        try {
            fixture?.dispose();
        } finally {
            if (tempRoot) {
                try {
                    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
                } catch (error) {
                    console.warn(`[playwright] temporary desktop files could not be removed: ${String(error)}`);
                }
            }
        }
    }
    if (failures.length > 0) {
        throw new Error(`Playwright desktop cleanup left live process(es): ${failures.join(', ')}`);
    }
}

function diagnosticText(resources: SessionResources): {
    readonly vscodeProcess: string;
    readonly vscodeFiles: string;
    readonly fakeServer: string;
} {
    const vscodeFiles = readDiagnosticFiles(resources.userDataDir);
    const fakeServer = readNamedFiles(resources.controlDir, [
        'fake-server.log',
        'launches.log',
        'server.pid',
        'module-explorer.json',
    ]);
    return {
        vscodeProcess: [
            '--- stdout ---',
            resources.stdout.join(''),
            '--- stderr ---',
            resources.stderr.join(''),
        ].join('\n'),
        vscodeFiles,
        fakeServer,
    };
}

function persistSessionDiagnostics(resources: SessionResources, namespace: string): void {
    persistDiagnosticFiles(namespace, [
        { name: 'recorded-initialize.json', path: path.join(resources.fixture.baseDir, 'recorded-initialize.json') },
        { name: 'fake-server.log', path: path.join(resources.controlDir, 'fake-server.log') },
        { name: 'launches.log', path: path.join(resources.controlDir, 'launches.log') },
        { name: 'server.pid', path: path.join(resources.controlDir, 'server.pid') },
        { name: 'module-explorer.json', path: path.join(resources.controlDir, 'module-explorer.json') },
    ]);
    persistDiagnosticDirectory(namespace, 'vscode-user-data', resources.userDataDir);
    const diagnostics = diagnosticText(resources);
    persistDiagnosticText(namespace, [
        { name: 'vscode-process.log', content: diagnostics.vscodeProcess },
        { name: 'vscode-user-data.log', content: diagnostics.vscodeFiles },
        { name: 'fake-server-summary.log', content: diagnostics.fakeServer },
    ]);
}

function readNamedFiles(rootDir: string, names: readonly string[]): string {
    return names.map((name) => {
        const filePath = path.join(rootDir, name);
        try {
            return `--- ${name} ---\n${fs.readFileSync(filePath, 'utf8')}`;
        } catch {
            return `--- ${name} ---\n(not available)`;
        }
    }).join('\n');
}

function readDiagnosticFiles(rootDir: string): string {
    const files: string[] = [];
    const visit = (dir: string, relativeDir: string): void => {
        if (files.length >= 32) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (files.length >= 32) {
                return;
            }
            const absolute = path.join(dir, entry.name);
            const relative = relativeDir === '' ? entry.name : path.join(relativeDir, entry.name);
            if (entry.isDirectory()) {
                visit(absolute, relative);
            } else if (entry.isFile()) {
                try {
                    const content = fs.readFileSync(absolute, 'utf8');
                    files.push(`--- ${relative} ---\n${content.slice(0, 256 * 1024)}`);
                } catch {
                    files.push(`--- ${relative} ---\n(unreadable)`);
                }
            }
        }
    };
    visit(path.join(rootDir, 'logs'), 'logs');
    return files.length === 0 ? '(no VS Code user-data logs were written)' : files.join('\n');
}

async function attachFile(testInfo: TestInfo, name: string, content: string): Promise<void> {
    const filePath = testInfo.outputPath(name);
    fs.writeFileSync(filePath, content);
    await testInfo.attach(name, { path: filePath, contentType: 'text/plain' });
}

export async function launchDesktopSession(): Promise<DesktopSession> {
    await requireDisplayForGuiTest('playwright');
    requireFile(COMPILED_EXTENSION, 'the compiled extension bundle');
    requireFile(COMPILED_FAKE_SERVER, 'the compiled fake language server');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hdlsupport-playwright-'));
    let fixture: WorkspaceFixture | undefined;
    let child: ChildProcess | undefined;
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let traceActive = false;
    const stdout: string[] = [];
    const stderr: string[] = [];

    try {
        fixture = createWorkspaceFixture('hdlsupport-playwright');
        const controlDir = path.join(fixture.baseDir, 'control');
        fs.mkdirSync(controlDir, { recursive: true });
        fixtureSettings(fixture, controlDir);

        const recordPath = path.join(fixture.baseDir, 'recorded-initialize.json');
        const fakeLogPath = path.join(controlDir, 'fake-server.log');
        const userDataDir = path.join(tempRoot, 'user-data');
        const extensionsDir = path.join(tempRoot, 'extensions');
        fs.mkdirSync(extensionsDir, { recursive: true });
        writeUserSettings(userDataDir);
        const cdpPort = await reserveLoopbackPort();
        const executable = await vscodeExecutablePath();
        const args = launchArguments(fixture, userDataDir, extensionsDir, cdpPort);
        child = spawn(executable, args, {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                LLG_FAKE_RECORD: recordPath,
                LLG_FAKE_CONTROL_DIR: controlDir,
                LLG_FAKE_LOG: fakeLogPath,
                HDLSUPPORT_TEST_MODE: '1',
                HDLSUPPORT_TEST_NODE_EXECUTABLE: process.execPath,
                HDLSUPPORT_TEST_SERVER_MODULE: path.resolve(COMPILED_FAKE_SERVER),
            },
            shell: false,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        attachOutput(child, stdout, stderr);

        if (!child.pid) {
            throw new Error('VS Code desktop process did not expose a PID');
        }
        await waitUntil(
            () => waitForCdpOrProcessExit(child as ChildProcess, cdpPort),
            'the VS Code loopback CDP endpoint',
            CDP_READY_TIMEOUT_MS,
        );
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, {
            // VS Code owns the default Electron context. Do not ask Playwright
            // to apply Browser.setDownloadBehavior or other context overrides
            // that this CDP endpoint does not support.
            isLocal: true,
            noDefaults: true,
        });
        context = browser.contexts()[0];
        if (!context) {
            throw new Error('the VS Code CDP connection exposed no browser context');
        }
        const page = await waitForPage(context);
        try {
            await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
            traceActive = true;
        } catch (error) {
            stderr.push(`Playwright tracing unavailable: ${String(error)}\n`);
        }

        const resources: SessionResources = {
            tempRoot,
            fixture,
            controlDir,
            userDataDir,
            child,
            browser,
            context,
            page,
            stdout,
            stderr,
            traceActive,
            disposed: false,
        };
        return {
            page,
            fixture,
            controlDir,
            async captureDiagnostics(testInfo: TestInfo): Promise<void> {
                try {
                    await page.screenshot({ path: testInfo.outputPath('workbench.png') });
                    await testInfo.attach('workbench screenshot', {
                        path: testInfo.outputPath('workbench.png'),
                        contentType: 'image/png',
                    });
                } catch (error) {
                    await attachFile(testInfo, 'screenshot-error.txt', String(error));
                }

                const diagnostics = diagnosticText(resources);
                persistSessionDiagnostics(resources, 'playwright');
                await attachFile(testInfo, 'vscode-process.log', diagnostics.vscodeProcess);
                await attachFile(testInfo, 'vscode-user-data.log', diagnostics.vscodeFiles);
                await attachFile(testInfo, 'fake-server.log', diagnostics.fakeServer);

                if (resources.traceActive) {
                    const tracePath = testInfo.outputPath('playwright-trace.zip');
                    try {
                        await resources.context.tracing.stop({ path: tracePath });
                        resources.traceActive = false;
                        await testInfo.attach('Playwright trace', {
                            path: tracePath,
                            contentType: 'application/zip',
                        });
                    } catch (error) {
                        await attachFile(testInfo, 'trace-error.txt', String(error));
                    }
                }
            },
            async dispose(): Promise<void> {
                if (resources.disposed) {
                    return;
                }
                resources.disposed = true;
                await cleanupResources(resources);
            },
        };
    } catch (error) {
        if (fixture) {
            persistDiagnosticFiles('playwright-startup', [
                { name: 'recorded-initialize.json', path: path.join(fixture.baseDir, 'recorded-initialize.json') },
                { name: 'fake-server.log', path: path.join(fixture.baseDir, 'control', 'fake-server.log') },
                { name: 'launches.log', path: path.join(fixture.baseDir, 'control', 'launches.log') },
                { name: 'server.pid', path: path.join(fixture.baseDir, 'control', 'server.pid') },
                { name: 'module-explorer.json', path: path.join(fixture.baseDir, 'control', 'module-explorer.json') },
            ]);
        }
        persistDiagnosticText('playwright-startup', [
            { name: 'vscode-process.log', content: `--- stdout ---\n${stdout.join('')}\n--- stderr ---\n${stderr.join('')}` },
        ]);
        persistDiagnosticDirectory('playwright-startup', 'vscode-user-data', path.join(tempRoot, 'user-data'));
        await cleanupResources({
            tempRoot,
            fixture,
            controlDir: fixture ? path.join(fixture.baseDir, 'control') : undefined,
            child,
            browser,
            context,
            traceActive,
        });
        throw error;
    }
}
