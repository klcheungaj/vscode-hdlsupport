// SPDX-License-Identifier: MIT
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
    activeTomlSection,
    extractLlgSearchDirectories,
    fieldsForSection,
    LLG_CONFIG_SECTIONS,
    LLG_LINT_RULES,
    quotedPathPrefix,
} from '../../clientFeatures/llgConfigPure';

describe('llg.toml editing metadata', () => {
    it('selects root, regular, and per-rule fields', () => {
        expect(activeTomlSection('schema_version = 1\n')).toBe('root');
        expect(activeTomlSection('[sources]\ndirectories = ["rtl"]\n[compile]\n')).toBe('compile');
        expect(fieldsForSection('lint.rules.unused-signal').map((field) => field.key)).toEqual(['enabled', 'severity']);
    });

    it('offers every built-in server lint rule in stable registry order', () => {
        expect(LLG_LINT_RULES).toEqual([
            'unused-signal',
            'width-mismatch',
            'incomplete-case',
            'combinational-loop',
            'multi-driver',
            'casez-misuse',
            'if-latch',
            'naming-style',
            'blocking-in-always_ff',
            'nba-in-always_comb',
            'unused-parameter',
            'implicit-net',
            'case-default-missing',
            'comparison-width-mismatch',
            'unconnected-port',
            'mixed-assignments',
            'undriven-signal',
            'incomplete-sensitivity-list',
            'out-of-range-select',
            'xz-logical-equality',
            'duplicate-case-item',
            'empty-implicit-sensitivity',
            'assignment-in-condition',
            'casex-statement',
        ]);
        expect(LLG_CONFIG_SECTIONS.filter((section) => section.startsWith('lint.rules.')))
            .toEqual(LLG_LINT_RULES.map((rule) => `lint.rules.${rule}`));
    });

    it('keeps the packaged JSON schema aligned with completion metadata', () => {
        const schema = JSON.parse(fs.readFileSync(
            path.join(process.cwd(), 'schemas', 'llg.schema.json'),
            'utf8',
        )) as {
            properties: { lint: { properties: { rules: { properties: Record<string, unknown> } } } };
        };
        expect(Object.keys(schema.properties.lint.properties.rules.properties)).toEqual(LLG_LINT_RULES);
    });

    it('extracts a path prefix only from supported path arrays', () => {
        expect(quotedPathPrefix('directories = ["rtl/inc')).toBe('rtl/inc');
        expect(quotedPathPrefix('include_dirs = ["../common/')).toBe('../common/');
        expect(quotedPathPrefix('include = ["rtl/')).toBeUndefined();
        expect(quotedPathPrefix("directories = ['rtl/inc")).toBe('rtl/inc');
        expect(quotedPathPrefix('directories = ["rtl"] # finished')).toBeUndefined();
        expect(quotedPathPrefix('directories = ["rtl/\\"quoted')).toBe('rtl/\\"quoted');
        expect(quotedPathPrefix('directories = [\n  "rtl/inc')).toBe('rtl/inc');
        expect(quotedPathPrefix('directories = [ # ] "ignored\n  "rtl/inc')).toBe('rtl/inc');
        expect(quotedPathPrefix('directories = ["rtl"]\n')).toBeUndefined();
    });

    it('extracts source and include search directories', () => {
        expect(extractLlgSearchDirectories(`
[sources]
directories = ["rtl", "../shared"]
[compile]
include_dirs = ["include"]
defines = ["directories=ignored"]
`)).toEqual([
            { section: 'sources', path: 'rtl' },
            { section: 'sources', path: '../shared' },
            { section: 'compile', path: 'include' },
        ]);
    });

    it('handles multiline arrays, literal strings, escaped quotes, and comments', () => {
        expect(extractLlgSearchDirectories(`
[sources]
directories = [
    "rtl",
    '../shared', # "ignored"
    "quoted\\\"dir"
]
[compile]
include_dirs = ["include"] # "not-a-directory"
`)).toEqual([
            { section: 'sources', path: 'rtl' },
            { section: 'sources', path: '../shared' },
            { section: 'sources', path: 'quoted"dir' },
            { section: 'compile', path: 'include' },
        ]);
    });

    it('ignores commented, malformed, and non-array path assignments', () => {
        expect(extractLlgSearchDirectories(`
# [sources]
# directories = ["commented"]
[sources]
directories = "not-an-array"
directories = ["unterminated"
`)).toEqual([]);
    });
});
