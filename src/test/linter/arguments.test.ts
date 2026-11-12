// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { splitArguments } from '../../linter/arguments';

describe('splitArguments', () => {
    it('returns an independent copy when arguments are already structured', () => {
        const configured = ['--define', 'NAME=value with spaces'];

        const result = splitArguments(configured);
        result.push('top.sv');

        expect(result).toEqual(['--define', 'NAME=value with spaces', 'top.sv']);
        expect(configured).toEqual(['--define', 'NAME=value with spaces']);
    });

    it('splits whitespace while preserving quoted and empty arguments', () => {
        expect(splitArguments(`--flag "two words" 'three words' "" ''`)).toEqual([
            '--flag',
            'two words',
            'three words',
            '',
            '',
        ]);
    });

    it('preserves Windows paths in quoted and unquoted arguments', () => {
        const input = String.raw`--tool "C:\Program Files\HDL Tools\lint.exe" --include 'D:\IP blocks\rtl' --root C:\work\rtl`;

        expect(splitArguments(input)).toEqual([
            '--tool',
            String.raw`C:\Program Files\HDL Tools\lint.exe`,
            '--include',
            String.raw`D:\IP blocks\rtl`,
            '--root',
            String.raw`C:\work\rtl`,
        ]);
    });

    it('returns shell metacharacters literally without evaluating or discarding them', () => {
        const input = "--define 'VALUE=$(touch /tmp/never-created)' ';' '&&' '| tee output' '`uname`'";

        expect(splitArguments(input)).toEqual([
            '--define',
            'VALUE=$(touch /tmp/never-created)',
            ';',
            '&&',
            '| tee output',
            '`uname`',
        ]);
    });

    it('supports escaped spaces and double quotes without dropping ordinary backslashes', () => {
        expect(splitArguments(String.raw`one\ two "say \"hello\"" C:\rtl\top.sv`)).toEqual([
            'one two',
            'say "hello"',
            String.raw`C:\rtl\top.sv`,
        ]);
    });

    it('rejects unterminated quotes instead of silently changing argument boundaries', () => {
        expect(() => splitArguments('--define "unfinished')).toThrow('Unterminated quote');
        expect(() => splitArguments("--define 'unfinished")).toThrow('Unterminated quote');
    });
});
