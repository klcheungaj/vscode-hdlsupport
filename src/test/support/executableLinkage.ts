// SPDX-License-Identifier: MIT

import { execFile } from 'child_process';

const INSPECTION_TIMEOUT_MS = 30_000;
const MAX_INSPECTION_OUTPUT_BYTES = 8 * 1024 * 1024;

const WINDOWS_SYSTEM_DLLS = new Set([
    'advapi32.dll',
    'bcrypt.dll',
    'bcryptprimitives.dll',
    'cabinet.dll',
    'cfgmgr32.dll',
    'combase.dll',
    'comctl32.dll',
    'crypt32.dll',
    'dbghelp.dll',
    'dnsapi.dll',
    'dwmapi.dll',
    'gdi32.dll',
    'iphlpapi.dll',
    'kernel32.dll',
    'msvcrt.dll',
    'mswsock.dll',
    'ncrypt.dll',
    'netapi32.dll',
    'normaliz.dll',
    'ntdll.dll',
    'ole32.dll',
    'oleaut32.dll',
    'powrprof.dll',
    'psapi.dll',
    'rpcrt4.dll',
    'secur32.dll',
    'setupapi.dll',
    'shell32.dll',
    'shlwapi.dll',
    'ucrtbase.dll',
    'user32.dll',
    'userenv.dll',
    'uxtheme.dll',
    'version.dll',
    'winhttp.dll',
    'wininet.dll',
    'winmm.dll',
    'winscard.dll',
    'winspool.drv',
    'ws2_32.dll',
    'wtsapi32.dll',
]);

const MACOS_SYSTEM_LIBRARIES = new Set([
    'libSystem.B.dylib',
    'libc++.1.dylib',
    'libc++abi.dylib',
    'libcompression.dylib',
    'libiconv.2.dylib',
    'libnetwork.dylib',
    'libobjc.A.dylib',
    'libresolv.9.dylib',
    'libsqlite3.dylib',
    'libxml2.2.dylib',
    'libz.1.dylib',
]);

interface CommandResult {
    readonly stdout: string;
    readonly stderr: string;
}

/** Verifies that an ELF executable has no dynamic loader or needed libraries. */
export function assertLinuxStaticLinkage(readelfOutput: string): void {
    if (!/^ELF Header:/m.test(readelfOutput) || !/^\s*Magic:\s+7f 45 4c 46\b/m.test(readelfOutput)) {
        throw new Error('readelf did not report a valid ELF file');
    }

    const type = /^\s*Type:\s+(\S+)/m.exec(readelfOutput)?.[1];
    if (type !== 'EXEC' && type !== 'DYN') {
        throw new Error(`ELF file is not an executable or static PIE (type: ${type ?? 'missing'})`);
    }
    const entryPointText = /^\s*Entry point address:\s+0x([0-9a-f]+)\s*$/im.exec(readelfOutput)?.[1];
    if (entryPointText === undefined || BigInt(`0x${entryPointText}`) === 0n) {
        throw new Error('ELF file has no executable entry point');
    }
    if (!/^Program Headers:/m.test(readelfOutput)) {
        throw new Error('readelf output is malformed: program headers are missing');
    }
    if (!/^\s*LOAD\s/m.test(readelfOutput)) {
        throw new Error('ELF file has no loadable program segment');
    }
    if (!/(?:^Dynamic section at|^There is no dynamic section in this file\.)/m.test(readelfOutput)) {
        throw new Error('readelf output is malformed: dynamic-section status is missing');
    }

    const interpreter = /^\s*INTERP\s/m.test(readelfOutput)
        || /Requesting program interpreter:/m.test(readelfOutput);
    const hasNeededEntry = /\(NEEDED\)/.test(readelfOutput);
    const neededLibraries = [...readelfOutput.matchAll(/\(NEEDED\)\s+Shared library:\s*\[([^\]]+)\]/g)]
        .map((match) => match[1]);
    if (interpreter || hasNeededEntry) {
        const details = [
            ...(interpreter ? ['a PT_INTERP program header'] : []),
            ...(hasNeededEntry ? [`DT_NEEDED libraries: ${neededLibraries.join(', ') || 'unparseable entry'}`] : []),
        ];
        throw new Error(`Linux executable is dynamically linked (${details.join('; ')}); build it for a musl target with static native dependencies`);
    }
}

/** Verifies that a PE executable imports only Windows operating-system DLLs. */
export function assertWindowsSystemLinkage(readobjOutput: string): void {
    if (!/^File:\s+.+/m.test(readobjOutput) || !/^Format:\s+(?:COFF|PE32)/m.test(readobjOutput)) {
        throw new Error('llvm-readobj did not report a valid PE/COFF file');
    }
    if (!/\bImageFileHeader\s*\{[\s\S]*?\bIMAGE_FILE_EXECUTABLE_IMAGE\b[\s\S]*?^\}/m.test(readobjOutput)) {
        throw new Error('PE/COFF file is not marked as an executable image');
    }
    if (/\bImageFileHeader\s*\{[\s\S]*?\bIMAGE_FILE_DLL\b[\s\S]*?^\}/m.test(readobjOutput)) {
        throw new Error('PE/COFF file is marked as a DLL rather than an executable');
    }

    const importBlocks = [...readobjOutput.matchAll(/^\s*(?:Import|DelayImport|DelayedImport)\s*\{([\s\S]*?)^\s*\}/gm)];
    const declaredImportCount = (readobjOutput.match(/^\s*(?:Import|DelayImport|DelayedImport)\s*\{/gm) ?? []).length;
    if (importBlocks.length !== declaredImportCount) {
        throw new Error('llvm-readobj output is malformed: an import block is incomplete');
    }

    const imports = importBlocks.map((block) => {
        const name = /^\s*Name:\s*(\S+)\s*$/m.exec(block[1])?.[1];
        if (name === undefined) {
            throw new Error('llvm-readobj output is malformed: an imported DLL has no name');
        }
        return name;
    });
    const rejected = imports.filter((library) => !isWindowsSystemDll(library));
    if (rejected.length > 0) {
        throw new Error(`Windows executable imports non-system libraries: ${rejected.join(', ')}; link language runtimes, allocators, and third-party libraries statically`);
    }
}

/** Verifies every Mach-O slice and permits only native macOS libraries. */
export function assertMacSystemLinkage(headerOutput: string, librariesOutput: string): void {
    const headerSlices = parseMacSlices(headerOutput, 'header');
    const librarySlices = parseMacSlices(librariesOutput, 'libraries');

    for (const slice of headerSlices) {
        if (!/\bMH_MAGIC(?:_64)?\b[\s\S]*\bEXECUTE\b/.test(slice.body)) {
            throw new Error(`Mach-O slice ${slice.name} is not an executable image`);
        }
    }
    if (headerSlices.length !== librarySlices.length
        || headerSlices.some((slice, index) => slice.name !== librarySlices[index].name)) {
        throw new Error('otool output is malformed: Mach-O slices differ between header and library reports');
    }

    const rejected: string[] = [];
    for (const slice of librarySlices) {
        const lines = slice.body.split(/\r?\n/).filter((line) => line.trim() !== '');
        for (const line of lines) {
            const path = /^\s*(\S+)\s+\(compatibility version\b/.exec(line)?.[1];
            if (path === undefined) {
                throw new Error(`otool output is malformed in Mach-O slice ${slice.name}: ${line.trim()}`);
            }
            if (!isMacSystemLibrary(path)) {
                rejected.push(`${path} (${slice.name})`);
            }
        }
    }
    if (rejected.length > 0) {
        throw new Error(`macOS executable links non-system libraries: ${rejected.join(', ')}; link language runtimes, allocators, and third-party libraries statically`);
    }
}

/** Inspects one packaged language-server executable using native object-file tools. */
export async function assertExecutableLinkage(
    binaryPath: string,
    platform: NodeJS.Platform = process.platform,
): Promise<void> {
    if (binaryPath.trim() === '') {
        throw new Error('Executable path must not be empty');
    }

    try {
        switch (platform) {
            case 'linux': {
                const result = await inspect('readelf', ['-h', '-l', '-d', '--wide', binaryPath], 'install binutils so readelf is available');
                assertLinuxStaticLinkage(result.stdout);
                return;
            }
            case 'win32': {
                const result = await inspect('llvm-readobj', ['--file-headers', '--coff-imports', binaryPath], 'install LLVM and add llvm-readobj to PATH');
                assertWindowsSystemLinkage(result.stdout);
                return;
            }
            case 'darwin': {
                const [headers, libraries] = await Promise.all([
                    inspect('otool', ['-arch', 'all', '-hv', binaryPath], 'install the Xcode Command Line Tools so otool is available'),
                    inspect('otool', ['-arch', 'all', '-L', binaryPath], 'install the Xcode Command Line Tools so otool is available'),
                ]);
                assertMacSystemLinkage(headers.stdout, libraries.stdout);
                return;
            }
            default:
                throw new Error(`inspection is not implemented for platform ${platform}`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Executable linkage check failed for ${binaryPath}: ${message}`);
    }
}

function isWindowsSystemDll(library: string): boolean {
    const normalized = library.toLowerCase();
    return WINDOWS_SYSTEM_DLLS.has(normalized)
        || /^api-ms-win-[a-z0-9-]+\.dll$/.test(normalized)
        || /^ext-ms-win-[a-z0-9-]+\.dll$/.test(normalized);
}

function isMacSystemLibrary(libraryPath: string): boolean {
    if (libraryPath.startsWith('/System/Library/Frameworks/')
        && libraryPath.includes('.framework/')
        && !libraryPath.split('/').includes('..')) {
        return true;
    }
    const match = /^\/usr\/lib\/([^/]+)$/.exec(libraryPath);
    return match !== null && MACOS_SYSTEM_LIBRARIES.has(match[1]);
}

interface MacSlice {
    readonly name: string;
    readonly body: string;
}

function parseMacSlices(output: string, report: 'header' | 'libraries'): MacSlice[] {
    if (output.trim() === '') {
        throw new Error(`otool ${report} output is empty`);
    }
    const markers = [...output.matchAll(/^(.+?)(?: \(architecture ([^)]+)\))?:\s*$/gm)];
    if (markers.length === 0) {
        throw new Error(`otool ${report} output is malformed: file header is missing`);
    }

    return markers.map((marker, index) => {
        const start = (marker.index ?? 0) + marker[0].length;
        const end = index + 1 < markers.length ? markers[index + 1].index : output.length;
        const name = marker[2] ?? 'single-architecture';
        const body = output.slice(start, end).trim();
        if (body === '') {
            throw new Error(`otool ${report} output is malformed: slice ${name} is empty`);
        }
        return { name, body };
    });
}

function inspect(command: string, args: readonly string[], guidance: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        execFile(command, args, {
            encoding: 'utf8',
            env: { ...process.env, ['LANG']: 'C', ['LC_ALL']: 'C' },
            maxBuffer: MAX_INSPECTION_OUTPUT_BYTES,
            shell: false,
            timeout: INSPECTION_TIMEOUT_MS,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            if (error !== null) {
                const detail = stderr.trim() || error.message;
                reject(new Error(`Could not inspect executable with ${command}: ${detail}. ${guidance}`));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}
