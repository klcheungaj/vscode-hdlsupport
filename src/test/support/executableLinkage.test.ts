// SPDX-License-Identifier: MIT

import * as child from 'child_process';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
    assertExecutableLinkage,
    assertLinuxStaticLinkage,
    assertMacSystemLinkage,
    assertWindowsSystemLinkage,
} from './executableLinkage';

vi.mock('child_process', async (importOriginal) => ({
    ...await importOriginal<typeof child>(),
    execFile: vi.fn(),
}));

const STATIC_EXEC_ELF = `ELF Header:
  Magic:   7f 45 4c 46 02 01 01 00
  Class:                             ELF64
  Type:                              EXEC (Executable file)
  Entry point address:               0x401000
Program Headers:
  Type           Offset             VirtAddr
  LOAD           0x0000000000000000 0x0000000000400000
There is no dynamic section in this file.
`;

const STATIC_PIE_ELF = `ELF Header:
  Magic:   7f 45 4c 46 02 01 01 00
  Class:                             ELF64
  Type:                              DYN (Position-Independent Executable file)
  Entry point address:               0x10f0
Program Headers:
  Type           Offset             VirtAddr
  LOAD           0x0000000000000000 0x0000000000000000
Dynamic section at offset 0x9be30 contains 20 entries:
  Tag        Type                         Name/Value
  0x0000000000000007 (RELA)               0x2d8
  0x0000000000000000 (NULL)               0x0
`;

const WINDOWS_HEADERS = `File: server.exe
Format: COFF-x86-64
Arch: x86_64
AddressSize: 64bit
ImageFileHeader {
  Machine: IMAGE_FILE_MACHINE_AMD64 (0x8664)
  Characteristics [ (0x22)
    IMAGE_FILE_EXECUTABLE_IMAGE (0x2)
    IMAGE_FILE_LARGE_ADDRESS_AWARE (0x20)
  ]
}
`;

const MAC_X86_HEADER = `server:
Mach header
      magic  cputype cpusubtype  caps    filetype ncmds sizeofcmds      flags
MH_MAGIC_64   X86_64        ALL  0x00     EXECUTE    19       1888   NOUNDEFS
`;

const MAC_X86_LIBRARIES = `server:
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1319.0.0)
\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 60420.0.0)
`;

afterEach(() => {
    vi.clearAllMocks();
});

describe('executable linkage inspection', () => {
    it.each([
        ['linux' as const, 'binutils'],
        ['win32' as const, 'LLVM'],
        ['darwin' as const, 'Xcode Command Line Tools'],
    ])('reports how to install a missing inspection tool on %s', async (platform, guidance) => {
        (child.execFile as unknown as Mock).mockImplementation((
            _command: string,
            _args: readonly string[],
            _options: object,
            callback: (error: Error, stdout: string, stderr: string) => void,
        ) => callback(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '', ''));

        await expect(assertExecutableLinkage('/tmp/server', platform)).rejects.toThrow(guidance);
    });

    it('fails closed on an unsupported platform', async () => {
        await expect(assertExecutableLinkage('/tmp/server', 'aix')).rejects.toThrow(/not implemented for platform aix/);
    });
});

describe('Linux executable linkage policy', () => {
    it('accepts a static ELF executable without a dynamic section', () => {
        expect(() => assertLinuxStaticLinkage(STATIC_EXEC_ELF)).not.toThrow();
    });

    it('accepts static PIE with relocation-only dynamic metadata', () => {
        expect(() => assertLinuxStaticLinkage(STATIC_PIE_ELF)).not.toThrow();
    });

    it('rejects a GNU dynamically linked executable', () => {
        const output = STATIC_PIE_ELF.replace(
            '  LOAD           0x0000000000000000 0x0000000000000000',
            '  LOAD           0x0000000000000000 0x0000000000000000\n  INTERP         0x0000000000000350 0x0000000000000350\n      [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]',
        ).replace(
            '  0x0000000000000007 (RELA)               0x2d8',
            '  0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]',
        );

        expect(() => assertLinuxStaticLinkage(output)).toThrow(/PT_INTERP.*libc\.so\.6/);
    });

    it('rejects DT_NEEDED without an interpreter', () => {
        const output = STATIC_PIE_ELF.replace(
            '  0x0000000000000007 (RELA)               0x2d8',
            '  0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]',
        );
        expect(() => assertLinuxStaticLinkage(output)).toThrow(/DT_NEEDED.*libc\.so\.6/);
    });

    it('rejects an interpreter without DT_NEEDED entries', () => {
        const output = STATIC_PIE_ELF.replace(
            '  LOAD           0x0000000000000000 0x0000000000000000',
            '  LOAD           0x0000000000000000 0x0000000000000000\n  INTERP         0x0000000000000350 0x0000000000000350\n      [Requesting program interpreter: /lib/ld-musl-x86_64.so.1]',
        );
        expect(() => assertLinuxStaticLinkage(output)).toThrow(/PT_INTERP/);
    });

    it('rejects a malformed DT_NEEDED entry rather than ignoring it', () => {
        const output = STATIC_PIE_ELF.replace(
            '  0x0000000000000007 (RELA)               0x2d8',
            '  0x0000000000000001 (NEEDED)             malformed',
        );
        expect(() => assertLinuxStaticLinkage(output)).toThrow(/unparseable entry/);
    });

    it.each([
        ['', /valid ELF/],
        ['not an object file', /valid ELF/],
        [STATIC_EXEC_ELF.replace('Type:                              EXEC', 'Type:                              REL'), /not an executable/],
        [STATIC_EXEC_ELF.replace('Entry point address:               0x401000', 'Entry point address:               0x0'), /no executable entry point/],
        [STATIC_EXEC_ELF.replace('  LOAD ', '  NOTE '), /no loadable program segment/],
        [STATIC_EXEC_ELF.replace('Program Headers:', 'Sections:'), /program headers are missing/],
        [STATIC_EXEC_ELF.replace('There is no dynamic section in this file.', ''), /dynamic-section status is missing/],
    ])('rejects malformed or non-executable readelf output', (output, message) => {
        expect(() => assertLinuxStaticLinkage(output)).toThrow(message);
    });
});

describe('Windows executable linkage policy', () => {
    it('accepts normal and delayed imports from Windows system DLLs case-insensitively', () => {
        const output = `${WINDOWS_HEADERS}
Import {
  Name: KERNEL32.dll
  Symbol: GetLastError (123)
}
DelayImport {
  Name: api-ms-win-core-synch-l1-2-0.DLL
  Symbol: WaitOnAddress (1)
}
DelayedImport {
  Name: EXT-MS-WIN-NTUSER-WINDOW-L1-1-0.dll
  Symbol: GetWindowRect (2)
}
`;

        expect(() => assertWindowsSystemLinkage(output)).not.toThrow();
    });

    it.each(['VCRUNTIME140.dll', 'msvcp140.dll', 'libgcc_s_seh-1.dll', 'libwinpthread-1.dll', 'mimalloc.dll'])('rejects redistributable or third-party import %s', (library) => {
        const output = `${WINDOWS_HEADERS}\nImport {\n  Name: ${library}\n}\n`;
        expect(() => assertWindowsSystemLinkage(output)).toThrow(new RegExp(library.replace('.', '\\.')));
    });

    it('rejects a delayed third-party import', () => {
        const output = `${WINDOWS_HEADERS}\nDelayImport {\n  Name: mimalloc.dll\n}\n`;
        expect(() => assertWindowsSystemLinkage(output)).toThrow(/mimalloc\.dll/);
    });

    it.each([
        ['', /valid PE\/COFF/],
        [WINDOWS_HEADERS.replace('Format: COFF-x86-64', 'Format: ELF64-x86-64'), /valid PE\/COFF/],
        [WINDOWS_HEADERS.replace('IMAGE_FILE_EXECUTABLE_IMAGE', 'IMAGE_FILE_DLL'), /not marked as an executable/],
        [WINDOWS_HEADERS.replace('IMAGE_FILE_LARGE_ADDRESS_AWARE', 'IMAGE_FILE_DLL'), /marked as a DLL/],
        [`${WINDOWS_HEADERS}\nImport {\n  Symbol: ExitProcess (1)\n}\n`, /has no name/],
        [`${WINDOWS_HEADERS}\nDelayImport {\n  Name: KERNEL32.dll\n`, /import block is incomplete/],
    ])('rejects malformed or non-executable llvm-readobj output', (output, message) => {
        expect(() => assertWindowsSystemLinkage(output)).toThrow(message);
    });
});

describe('macOS executable linkage policy', () => {
    it('accepts an executable linked only to native libraries and system frameworks', () => {
        expect(() => assertMacSystemLinkage(MAC_X86_HEADER, MAC_X86_LIBRARIES)).not.toThrow();
    });

    it('checks every architecture in a universal executable', () => {
        const headers = `server (architecture x86_64):
Mach header
MH_MAGIC_64 X86_64 ALL 0x00 EXECUTE 19 1888 NOUNDEFS
server (architecture arm64):
Mach header
MH_MAGIC_64 ARM64 ALL 0x00 EXECUTE 19 1888 NOUNDEFS
`;
        const libraries = `server (architecture x86_64):
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1319.0.0)
server (architecture arm64):
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 1953.0.0)
`;

        expect(() => assertMacSystemLinkage(headers, libraries)).not.toThrow();
    });

    it.each([
        '@rpath/libmimalloc.dylib',
        '@loader_path/libgcc_s.1.1.dylib',
        '/opt/homebrew/lib/libtcl8.6.dylib',
        '/usr/local/lib/libsoftbrush.dylib',
        '/usr/lib/libUnknown.dylib',
    ])('rejects non-system library %s', (library) => {
        const output = MAC_X86_LIBRARIES.replace('/usr/lib/libSystem.B.dylib', library);
        expect(() => assertMacSystemLinkage(MAC_X86_HEADER, output)).toThrow(/non-system libraries/);
    });

    it.each([
        ['', MAC_X86_LIBRARIES, /header output is empty/],
        ['PE32 executable', MAC_X86_LIBRARIES, /file header is missing/],
        [MAC_X86_HEADER.replace('EXECUTE', 'DYLIB'), MAC_X86_LIBRARIES, /not an executable image/],
        [MAC_X86_HEADER, 'server:\nmalformed dependency', /malformed/],
    ])('rejects malformed or non-executable otool output', (headers, libraries, message) => {
        expect(() => assertMacSystemLinkage(headers, libraries)).toThrow(message);
    });

    it('rejects reports that omit one universal-binary slice', () => {
        const headers = `server (architecture x86_64):\nMach header\nMH_MAGIC_64 X86_64 ALL EXECUTE\nserver (architecture arm64):\nMach header\nMH_MAGIC_64 ARM64 ALL EXECUTE\n`;
        expect(() => assertMacSystemLinkage(headers, MAC_X86_LIBRARIES)).toThrow(/slices differ/);
    });

    it('rejects a library report with an unexpected extra universal-binary slice', () => {
        const libraries = `${MAC_X86_LIBRARIES}server (architecture arm64):\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1319.0.0)\n`;
        expect(() => assertMacSystemLinkage(MAC_X86_HEADER, libraries)).toThrow(/slices differ/);
    });
});
