// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
    diagnosticWaiverId,
    isExternalLinterSource,
    isDiagnosticWaived,
    lineWaivesDiagnostic,
    verilatorDocumentationUrl,
} from '../../clientFeatures/lintWaiversPure';

const diagnostic = {
    source: 'Verilator',
    code: 'UNUSEDSIGNAL',
    range: { start: { line: 2 } },
};

describe('external-linter waivers', () => {
    it('normalizes string, numeric, and code-description identifiers', () => {
        expect(diagnosticWaiverId(diagnostic)).toBe('verilator:unusedsignal');
        expect(diagnosticWaiverId({ source: 'xvlog', code: 42 })).toBe('xvlog:42');
        expect(diagnosticWaiverId({ source: 'slang', code: { value: 'unused' } })).toBe('slang:unused');
        expect(diagnosticWaiverId({ source: 'slang' })).toBeUndefined();
    });

    it('matches exact inline markers, case-insensitively', () => {
        expect(lineWaivesDiagnostic('logic unused; // hdlsupport-lint-waive VERILATOR:UNUSEDSIGNAL', 'verilator:unusedsignal')).toBe(true);
        expect(lineWaivesDiagnostic('// hdlsupport-lint-waive verilator:other', 'verilator:unusedsignal')).toBe(false);
        expect(lineWaivesDiagnostic(
            'logic unused; // hdlsupport-lint-waive verilator:width // hdlsupport-lint-waive verilator:unusedsignal',
            'verilator:unusedsignal',
        )).toBe(true);
    });

    it('supports resource configuration and same/previous-line markers', () => {
        expect(isDiagnosticWaived(diagnostic, ['VERILATOR:UNUSEDSIGNAL'], [])).toBe(true);
        expect(isDiagnosticWaived(diagnostic, [], ['', '// hdlsupport-lint-waive verilator:unusedsignal', 'logic unused;'])).toBe(true);
        expect(isDiagnosticWaived(diagnostic, [], ['', '', 'logic unused; // hdlsupport-lint-waive verilator:unusedsignal'])).toBe(true);
        expect(isDiagnosticWaived(diagnostic, [], ['', '', 'logic unused;'])).toBe(false);
    });

    it('identifies only supported external-linter sources', () => {
        expect(isExternalLinterSource(' ModelSim ')).toBe(true);
        expect(isExternalLinterSource('llg-lint')).toBe(false);
        expect(isExternalLinterSource(undefined)).toBe(false);
    });

    it('builds documentation URLs only for coded Verilator diagnostics', () => {
        expect(verilatorDocumentationUrl(diagnostic)).toBe(
            'https://verilator.org/guide/latest/warnings.html#cmdoption-Wno-UNUSEDSIGNAL',
        );
        expect(verilatorDocumentationUrl({ source: 'slang', code: 'unused' })).toBeUndefined();
        expect(verilatorDocumentationUrl({ source: 'verilator' })).toBeUndefined();
    });
});
