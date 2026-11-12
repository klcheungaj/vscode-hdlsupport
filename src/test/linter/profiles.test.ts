// SPDX-License-Identifier: MIT
/* eslint-disable @typescript-eslint/naming-convention -- legacy configuration keys contain dots. */
import { describe, expect, it } from 'vitest';

import { findLinterProfile, linterProfiles } from '../../linter/profiles';
import { modelsim } from '../../linter/profiles/modelsim';
import { slang } from '../../linter/profiles/slang';
import { LANGUAGE_STANDARD, LinterContext, parseDiagnostics } from '../../linter/profiles/types';
import { verilator } from '../../linter/profiles/verilator';
import { xvlog } from '../../linter/profiles/xvlog';

function context(overrides: Partial<LinterContext> = {}, settings: Record<string, unknown> = {}): LinterContext {
    return {
        file: '/workspace/rtl/top.sv',
        languageId: 'systemverilog',
        includeDirectories: ['/workspace/includes', '/workspace/IP blocks/rtl'],
        get: <T>(key: string, fallback: T): T => (settings[key] as T | undefined) ?? fallback,
        ...overrides,
    };
}

describe('external-linter profile registry', () => {
    it('exposes each supported linter under its configured ID', () => {
        expect(linterProfiles.map(profile => profile.id)).toEqual([
            'xvlog',
            'modelsim',
            'verilator',
            'slang',
        ]);
        expect(findLinterProfile('modelsim')).toBe(modelsim);
        expect(findLinterProfile('unknown')).toBeUndefined();
    });
});

describe('external-linter diagnostic profiles', () => {
    it('parses xvlog severity, diagnostic code, Windows path, and colons in the message', () => {
        const output = String.raw`ERROR: [VRFC 10-2989] signal: 'ready' is not declared [C:\Projects\chip design\top.sv:42]`;

        expect(parseDiagnostics(xvlog, output)).toEqual([{
            file: String.raw`C:\Projects\chip design\top.sv`,
            line: 41,
            column: 0,
            message: "signal: 'ready' is not declared",
            code: 'VRFC 10-2989',
            severity: 'error',
        }]);
    });

    it('parses ModelSim severity and the tool diagnostic code', () => {
        const output = String.raw`** Error: (vlog-13069) C:\Projects\chip design\top.sv(15): near ":": syntax error`;

        expect(parseDiagnostics(modelsim, output)).toEqual([{
            file: String.raw`C:\Projects\chip design\top.sv`,
            line: 14,
            column: 0,
            message: 'near ":": syntax error',
            code: 'vlog-13069',
            severity: 'error',
        }]);
    });

    it('parses Verilator diagnostics both with and without a column', () => {
        const output = [
            String.raw`%Warning-WIDTH: C:\Projects\chip design\top.sv:21:9: Operator ASSIGN expects: 8 bits`,
            String.raw`%Error: C:\Projects\chip design\top.sv:22: syntax error: unexpected end`,
        ].join('\n');

        expect(parseDiagnostics(verilator, output)).toEqual([
            {
                file: String.raw`C:\Projects\chip design\top.sv`,
                line: 20,
                column: 8,
                message: 'Operator ASSIGN expects: 8 bits',
                code: 'WIDTH',
                severity: 'warning',
            },
            {
                file: String.raw`C:\Projects\chip design\top.sv`,
                line: 21,
                column: 0,
                message: 'syntax error: unexpected end',
                code: undefined,
                severity: 'error',
            },
        ]);
    });

    it('parses slang severity and warning code without retaining the code in the message', () => {
        const output = String.raw`C:\Projects\chip design\top.sv:33:4: warning: implicit conversion: loses bits [-Wwidth-trunc]`;

        expect(parseDiagnostics(slang, output)).toEqual([{
            file: String.raw`C:\Projects\chip design\top.sv`,
            line: 32,
            column: 3,
            message: 'implicit conversion: loses bits',
            code: 'width-trunc',
            severity: 'warning',
        }]);
    });

    it.each([
        [
            'xvlog info',
            xvlog,
            'INFO: [VRFC 10-100] compiling module top [/workspace/top.sv:2]',
            { severity: 'information', code: 'VRFC 10-100' },
        ],
        [
            'ModelSim warning',
            modelsim,
            '** Warning: (vlog-2240) /workspace/top.sv(2): treated as a wire',
            { severity: 'warning', code: 'vlog-2240' },
        ],
        [
            'Verilator info',
            verilator,
            '%Info-TRACE: /workspace/top.sv:2:1: tracing is enabled',
            { severity: 'information', code: 'TRACE' },
        ],
        [
            'slang note',
            slang,
            '/workspace/top.sv:2:1: note: declared here',
            { severity: 'information', code: undefined },
        ],
    ])('maps severity and code from %s output', (_name, profile, output, expected) => {
        expect(parseDiagnostics(profile, output)).toEqual([
            expect.objectContaining(expected),
        ]);
    });

    it.each([
        ['xvlog', xvlog, 'WARNING: [VRFC 10-1] invalid line [/workspace/top.sv:0]'],
        ['modelsim', modelsim, '** Warning: /workspace/top.sv(0): invalid line'],
        ['verilator line', verilator, '%Error: /workspace/top.sv:0:4: invalid line'],
        ['verilator column', verilator, '%Error: /workspace/top.sv:4:0: invalid column'],
        ['slang line', slang, '/workspace/top.sv:0:4: error: invalid line'],
        ['slang column', slang, '/workspace/top.sv:4:0: error: invalid column'],
    ])('rejects invalid one-based positions from %s', (_name, profile, output) => {
        expect(parseDiagnostics(profile, output)).toEqual([]);
    });

    it('rejects unsafe numeric positions and ignores non-diagnostic output', () => {
        const output = [
            'Verilator 5.036 2025-04-27 rev v5.036',
            '%Error: /workspace/top.sv:999999999999999999999:2: impossible line',
            'make: *** [lint] Error 1',
            '',
        ].join('\n');

        expect(parseDiagnostics(verilator, output)).toEqual([]);
    });

    it.each([
        ['xvlog', xvlog, 'INFO: xvlog finished with 0 errors'],
        ['modelsim', modelsim, 'Model Technology ModelSim vlog 2024.1 Compiler'],
        ['verilator', verilator, 'Verilator 5.036 2025-04-27 rev v5.036'],
        ['slang', slang, 'Build succeeded: 0 errors, 0 warnings'],
    ])('ignores non-diagnostic %s output', (_name, profile, output) => {
        expect(parseDiagnostics(profile, output)).toEqual([]);
    });
});

describe('external-linter argument profiles', () => {
    it('adds xvlog SystemVerilog mode and include flags only where required', () => {
        expect(xvlog.defaultArguments).toEqual(['-nolog']);
        expect(xvlog.arguments(context())).toEqual([
            '-sv',
            '-i',
            '/workspace/includes',
            '-i',
            '/workspace/IP blocks/rtl',
        ]);
        expect(xvlog.arguments(context({ languageId: 'verilog' }))).not.toContain('-sv');
    });

    it('passes ModelSim work library, SystemVerilog mode, and include directories', () => {
        expect(modelsim.defaultArguments).toEqual(['-nologo']);
        expect(modelsim.arguments(context({}, { work: 'sim work' }))).toEqual([
            '-work',
            'sim work',
            '-sv',
            '+incdir+/workspace/includes',
            '+incdir+/workspace/IP blocks/rtl',
        ]);
    });

    it('passes Verilator include directories dynamically and the fixed standard as defaults', () => {
        expect(LANGUAGE_STANDARD).toBe('1800-2009');
        expect(verilator.defaultArguments).toEqual(['--lint-only', '+1800-2009ext+v', '+1800-2009ext+sv']);
        expect(verilator.arguments(context())).toEqual(['-I/workspace/includes', '-I/workspace/IP blocks/rtl']);
        expect(verilator.arguments(context({ languageId: 'verilog' }))).not.toContain('-sv');
    });

    it('passes slang include directories without combining paths with other arguments', () => {
        expect(slang.defaultArguments).toEqual([]);
        expect(slang.arguments(context())).toEqual([
            '-I',
            '/workspace/includes',
            '-I',
            '/workspace/IP blocks/rtl',
        ]);
    });
});
