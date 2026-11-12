import { accessSync, constants as fsConstants } from 'fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveOnPath, resolveServerExecutable, validateExecutable } from '../../languageServer/resolve';

const LINUX_X64 = { platform: 'linux', arch: 'x64', extensionUri: '/extensions/hdl-support' };
const SOFTBRUSH_IDENTITY = {
    name: 'Softbrush',
    binary: 'softbrush_ls',
    pathSetting: 'hdlsupport.softbrush.path',
};

describe('resolveServerExecutable', () => {
    let tempRoot: string;

    beforeAll(async () => {
        tempRoot = await mkdtemp(path.join(tmpdir(), 'llg-resolve-path-'));
    });

    afterAll(async () => {
        await rm(tempRoot, { recursive: true, force: true });
    });

    it('uses a non-empty setting path verbatim as override', () => {
        const result = resolveServerExecutable({
            ...LINUX_X64,
            settingPath: '/opt/llg/bin/llg',
        });
        expect(result).toEqual({ kind: 'override', path: '/opt/llg/bin/llg' });
    });

    it('resolves a bare executable name against the given PATH', async () => {
        const binDir = path.join(tempRoot, 'bin');
        await mkdir(binDir);
        const executable = path.join(binDir, 'llg-fake');
        await writeFile(executable, '#!/bin/sh\n');
        await chmod(executable, 0o755);
        const result = resolveServerExecutable({
            ...LINUX_X64,
            settingPath: 'llg-fake',
            pathEnv: `${path.join(tempRoot, 'missing-dir')}${path.delimiter}${binDir}`,
        });
        expect(result).toEqual({ kind: 'override', path: executable });
    });

    it('resolves a bare Softbrush name to an .exe file on Windows', async () => {
        const binDir = path.join(tempRoot, 'windows-bin');
        await mkdir(binDir);
        const executable = path.join(binDir, 'softbrush_ls.exe');
        await writeFile(executable, 'binary');
        await chmod(executable, 0o755);

        const result = resolveServerExecutable({
            settingPath: 'softbrush_ls',
            platform: 'win32',
            arch: 'x64',
            extensionUri: '/extensions/hdl-support',
            pathEnv: binDir,
        }, SOFTBRUSH_IDENTITY);

        expect(result).toEqual({ kind: 'override', path: executable });
    });

    it('reports an actionable error when a bare name is not on PATH', () => {
        const result = resolveServerExecutable({
            ...LINUX_X64,
            settingPath: 'no-such-llg-anywhere',
            pathEnv: '',
        });
        expect(result.kind).toBe('unsupported');
        if (result.kind === 'unsupported') {
            expect(result.error).toContain('no-such-llg-anywhere');
            expect(result.error).toContain('PATH');
            expect(result.error).toContain('hdlsupport.llg.path');
        }
    });

    it('keeps relative overrides containing a separator verbatim', () => {
        const result = resolveServerExecutable({
            ...LINUX_X64,
            settingPath: 'tools/bin/llg',
            pathEnv: '',
        });
        expect(result).toEqual({ kind: 'override', path: 'tools/bin/llg' });
    });

    it('resolves the bundled linux-x64 binary on linux x64', () => {
        const result = resolveServerExecutable({
            settingPath: '',
            platform: LINUX_X64.platform,
            arch: LINUX_X64.arch,
            extensionUri: LINUX_X64.extensionUri,
        });
        expect(result).toEqual({
            kind: 'bundled',
            path: path.join('/extensions/hdl-support', 'server', 'linux-x64', 'llg_ls'),
        });
    });

    describe.each([
        ['darwin', 'arm64'],
        ['win32', 'x64'],
        ['linux', 'arm64'],
    ])('unsupported host %s-%s', (platform, arch) => {
        it('reports an actionable unsupported error', () => {
            const result = resolveServerExecutable({ settingPath: '', platform, arch, extensionUri: '/ext' });
            expect(result.kind).toBe('unsupported');
            if (result.kind === 'unsupported') {
                expect(result.error).toContain('hdlsupport.llg.path');
                expect(result.error).toContain('linux-x64');
            }
        });
    });

    describe('alternate server identity', () => {
        it('resolves the bundled Softbrush binary on linux x64', () => {
            const result = resolveServerExecutable({
                ...LINUX_X64,
                settingPath: '',
            }, SOFTBRUSH_IDENTITY);

            expect(result).toEqual({
                kind: 'bundled',
                path: path.join('/extensions/hdl-support', 'server', 'linux-x64', 'softbrush_ls'),
            });
        });

        it('names Softbrush and its setting in PATH and unsupported-host errors', () => {
            const missingOverride = resolveServerExecutable({
                ...LINUX_X64,
                settingPath: 'missing-softbrush-command',
                pathEnv: '',
            }, SOFTBRUSH_IDENTITY);
            const unsupportedHost = resolveServerExecutable({
                settingPath: '',
                platform: 'win32',
                arch: 'x64',
                extensionUri: '/ext',
            }, SOFTBRUSH_IDENTITY);

            expect(missingOverride).toEqual({
                kind: 'unsupported',
                error: expect.stringContaining('hdlsupport.softbrush.path'),
            });
            if (missingOverride.kind === 'unsupported') {
                expect(missingOverride.error).toContain('Softbrush');
                expect(missingOverride.error).toContain('PATH');
            }
            expect(unsupportedHost).toEqual({
                kind: 'unsupported',
                error: expect.stringContaining('hdlsupport.softbrush.path'),
            });
            if (unsupportedHost.kind === 'unsupported') {
                expect(unsupportedHost.error).toContain('Softbrush');
                expect(unsupportedHost.error).toContain('linux-x64');
            }
        });
    });
});

describe('resolveOnPath', () => {
    let tempRoot: string;
    let binDir: string;

    beforeAll(async () => {
        tempRoot = await mkdtemp(path.join(tmpdir(), 'llg-on-path-test-'));
        binDir = path.join(tempRoot, 'first');
        const secondDir = path.join(tempRoot, 'second');
        await mkdir(binDir);
        await mkdir(secondDir);

        await writeFile(path.join(binDir, 'executable-name'), '#!/bin/sh\n');
        await chmod(path.join(binDir, 'executable-name'), 0o755);

        await mkdir(path.join(secondDir, 'directory-shadow'));
        const plainFile = path.join(secondDir, 'plain-file');
        await writeFile(plainFile, 'data');
        await chmod(plainFile, 0o644);
    });

    afterAll(async () => {
        await rm(tempRoot, { recursive: true, force: true });
    });

    function assertExecutable(candidate: string): void {
        expect(() => accessSync(candidate, fsConstants.X_OK)).not.toThrow();
    }

    it('returns the first PATH entry holding an executable regular file', () => {
        const resolved = resolveOnPath(
            'executable-name',
            `${path.join(tempRoot, 'absent')}${path.delimiter}${binDir}`,
        );
        expect(resolved).toBe(path.join(binDir, 'executable-name'));
        assertExecutable(resolved!);
    });

    it('prefers the exact executable name over the Windows .exe fallback', async () => {
        const exact = path.join(binDir, 'softbrush-precedence');
        const fallback = `${exact}.exe`;
        await writeFile(exact, '#!/bin/sh\n');
        await writeFile(fallback, 'binary');
        await chmod(exact, 0o755);
        await chmod(fallback, 0o755);

        expect(resolveOnPath('softbrush-precedence', binDir, 'win32')).toBe(exact);
    });

    it('does not apply the .exe fallback on non-Windows hosts', async () => {
        const windowsOnly = path.join(binDir, 'softbrush-windows-only.exe');
        await writeFile(windowsOnly, 'binary');
        await chmod(windowsOnly, 0o755);

        expect(resolveOnPath('softbrush-windows-only', binDir, 'linux')).toBeNull();
        expect(resolveOnPath('softbrush-windows-only', binDir, 'win32')).toBe(windowsOnly);
    });

    it('skips empty PATH entries instead of treating them as the current directory', () => {
        const resolved = resolveOnPath(
            'executable-name',
            `${path.join(tempRoot, 'absent')}${path.delimiter}${''}${path.delimiter}${binDir}`,
        );
        expect(resolved).toBe(path.join(binDir, 'executable-name'));
    });

    it('skips entries whose match is a directory or a non-executable file', () => {
        const secondDir = path.join(tempRoot, 'second');
        const resolved = resolveOnPath(
            'directory-shadow',
            `${secondDir}${path.delimiter}${binDir}`,
        );
        expect(resolved).toBeNull();

        const plain = resolveOnPath('plain-file', secondDir);
        expect(plain).toBeNull();
    });

    it('returns null when no entry matches', () => {
        expect(resolveOnPath('never-created', binDir)).toBeNull();
        expect(resolveOnPath('never-created', '')).toBeNull();
    });
});

describe('validateExecutable', () => {
    let tempRoot: string;

    beforeAll(async () => {
        tempRoot = await mkdtemp(path.join(tmpdir(), 'llg-resolve-test-'));
    });

    afterAll(async () => {
        await rm(tempRoot, { recursive: true, force: true });
    });

    it('returns null for an existing executable file', async () => {
        const executable = path.join(tempRoot, 'llg-ok');
        await writeFile(executable, '#!/bin/sh\n');
        await chmod(executable, 0o755);
        expect(await validateExecutable(executable)).toBeNull();
    });

    it('reports a missing file', async () => {
        const missing = path.join(tempRoot, 'does-not-exist');
        const error = await validateExecutable(missing);
        expect(error).toBeTruthy();
        expect(error).toContain('not found');
    });

    it('rejects a directory', async () => {
        const directory = path.join(tempRoot, 'a-directory');
        await mkdir(directory);
        const error = await validateExecutable(directory);
        expect(error).toBeTruthy();
        expect(error).toContain('not a regular file');
    });

    it('rejects a file without execute permission', async () => {
        const file = path.join(tempRoot, 'no-exec-bit');
        await writeFile(file, 'data');
        await chmod(file, 0o644);
        const error = await validateExecutable(file);
        expect(error).toBeTruthy();
        expect(error).toContain('not executable');
    });

    it('uses the Softbrush identity in missing and invalid executable errors', async () => {
        const missing = await validateExecutable(
            path.join(tempRoot, 'missing-softbrush'),
            SOFTBRUSH_IDENTITY,
        );
        const directory = path.join(tempRoot, 'softbrush-directory');
        await mkdir(directory);
        const invalid = await validateExecutable(directory, SOFTBRUSH_IDENTITY);

        expect(missing).toContain('Softbrush');
        expect(missing).toContain('hdlsupport.softbrush.path');
        expect(invalid).toContain('Softbrush');
        expect(invalid).toContain('hdlsupport.softbrush.path');
        expect(invalid).toContain('not a regular file');
    });
});
