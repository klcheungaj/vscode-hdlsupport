import { describe, expect, it } from 'vitest';

import { ScopedToken, tokenize, tokenWithText } from './grammarHarness';

/** The innermost theme-colored scope (not `meta.*` or the root), without its language suffix. */
function colorScope(token: ScopedToken): string | undefined {
    return token.scopes.slice(1).filter((scope) => !scope.startsWith('meta.')).at(-1)?.replace(/\.(tcl|sdc|xdc)$/, '');
}

/**
 * The innermost colored scope, without the dialect suffix, of the first token whose
 * text is `text` once trimmed; unscoped words merge with adjacent spaces.
 */
function scopeOf(lines: ScopedToken[][], text: string): string | undefined {
    const token = lines.flat().find((candidate) => candidate.text.trim() === text.trim());
    if (token === undefined) {
        throw new Error(`no token ${JSON.stringify(text)} in ${JSON.stringify(lines.flat().map((t) => t.text))}`);
    }
    return colorScope(token);
}

describe('Tcl TextMate grammar', () => {
    it('classifies command names, keywords, options, numbers and variables like Softbrush', async () => {
        const lines = await tokenize('source.tcl', ['puts -nonewline stdout $value(key) ; expr -3.5e2', 'catch 0x10']);

        expect(scopeOf(lines, 'puts')).toBe('entity.name.function');
        expect(scopeOf(lines, '-nonewline')).toBe('keyword.operator');
        expect(scopeOf(lines, 'stdout')).toBeUndefined();
        expect(scopeOf(lines, '$value(key)')).toBe('variable.other.readwrite');
        expect(scopeOf(lines, 'expr')).toBe('keyword.control');
        expect(scopeOf(lines, '-3.5e2')).toBe('constant.numeric');
        expect(scopeOf(lines, 'catch')).toBe('keyword.control');
        expect(scopeOf(lines, '0x10')).toBeUndefined();
    });

    it('recognizes comments only where a command starts', async () => {
        const lines = await tokenize('source.tcl', ['  # command comment', 'puts #literal', 'set value 1; # trailing']);

        expect(scopeOf(lines, '# command comment')).toBe('comment');
        expect(scopeOf(lines, '# trailing')).toBe('comment');
        expect(scopeOf(lines, '#literal')).toBeUndefined();
    });

    it('keeps braced words literal, including script bodies', async () => {
        const lines = await tokenize('source.tcl', ['if {$x > 0} {', '    puts $x', '}']);

        expect(lines.flat().filter((token) => token.text.trim() !== '' && token.text !== 'if')
            .every((token) => colorScope(token) === 'string.braced')).toBe(true);
    });

    it('colors substitutions inside quoted strings on top of the string', async () => {
        const lines = await tokenize('source.tcl', ['puts "a $x [list -y 2] \\$z"']);

        expect(tokenWithText(lines, '$x').scopes).toEqual(expect.arrayContaining(['string.tcl', 'variable.other.readwrite.tcl']));
        expect(scopeOf(lines, 'list')).toBe('entity.name.function');
        expect(scopeOf(lines, '-y')).toBe('keyword.operator');
        expect(scopeOf(lines, '2')).toBe('constant.numeric');
        expect(tokenWithText(lines, '\\$').scopes).not.toContain('variable.other.readwrite.tcl');
    });

    it('declares procedures, parameters, variables and namespaces', async () => {
        const lines = await tokenize('source.tcl', [
            'proc add {a {b 2} args} { return $a }',
            'set total 0',
            'set only',
            'variable count',
            'namespace eval ::util {}',
        ]);

        expect(scopeOf(lines, 'proc')).toBe('keyword.control');
        expect(scopeOf(lines, 'add')).toBe('entity.name.function');
        expect(['a', 'b', 'args'].map((name) => scopeOf(lines, name))).toEqual(Array(3).fill('variable.parameter'));
        expect(scopeOf(lines, '2')).toBeUndefined();
        expect(scopeOf(lines, 'total')).toBe('variable.other.readwrite');
        expect(scopeOf(lines, 'only')).toBeUndefined();
        expect(scopeOf(lines, 'count')).toBe('variable.other.readwrite');
        expect(scopeOf(lines, '::util')).toBe('entity.name.namespace');
    });

    it('continues a command across a backslash-newline', async () => {
        const lines = await tokenize('source.tcl', ['lappend items \\', '    -flag value', 'next']);

        expect(scopeOf(lines, '-flag')).toBe('keyword.operator');
        expect(scopeOf(lines, 'next')).toBe('entity.name.function');
    });

    it('starts a word right after an argument expansion', async () => {
        const lines = await tokenize('source.tcl', ['test name {*}{', '    -body x', '}']);

        expect(scopeOf(lines, '    -body x')).toBe('string.braced');
    });
});

describe.each([['SDC', 'source.sdc'], ['XDC', 'source.xdc']])('%s TextMate grammar', (_name, scopeName) => {
    it('marks options as keywords and braces as operators around string content', async () => {
        const lines = await tokenize(scopeName, ['set_property -dict {PACKAGE_PIN U16} [get_ports clk]']);

        expect(lines.flat().every((token) => token.scopes.includes(scopeName))).toBe(true);
        expect(scopeOf(lines, '-dict')).toBe('keyword.control');
        expect(scopeOf(lines, '{')).toBe('keyword.operator');
        expect(scopeOf(lines, 'PACKAGE_PIN U16')).toBe('string.braced');
        expect(scopeOf(lines, 'get_ports')).toBe('entity.name.function');
        expect(scopeOf(lines, 'clk')).toBeUndefined();
    });

    it('declares clocks by name or by their single port or pin target', async () => {
        const lines = await tokenize(scopeName, [
            'create_clock -name sys_clk -period 10 [get_ports clk]',
            'create_clock -period 8 [get_ports {rx_clk}]',
            'create_generated_clock -source [get_pins a] -phase 90 [get_pins gen_clk]',
        ]);

        expect(scopeOf(lines, 'sys_clk')).toBe('variable.other.readwrite');
        expect(scopeOf(lines, 'clk')).toBeUndefined();
        expect(scopeOf(lines, 'rx_clk')).toBe('variable.other.readwrite');
        // An option of unknown arity hides the target, as in Softbrush.
        expect(scopeOf(lines, 'gen_clk')).toBeUndefined();
    });

    it('keeps clock references out of strings and numbers', async () => {
        const lines = await tokenize(scopeName, [
            'set_clock_groups -group {clk_a {clk_b}} -group "clk_c"',
            'set_input_delay -clock 100 -max 2 [get_ports d]',
            'get_clocks -filter {NAME =~ clk*}',
        ]);

        expect(scopeOf(lines, 'clk_a ')).toBeUndefined();
        expect(scopeOf(lines, 'clk_b')).toBeUndefined();
        expect(scopeOf(lines, '}')).toBe('keyword.operator');
        expect(scopeOf(lines, '"clk_c"')).toBeUndefined();
        expect(scopeOf(lines, '100')).toBeUndefined();
        expect(scopeOf(lines, '2')).toBe('constant.numeric');
        expect(scopeOf(lines, 'NAME =~ clk*')).toBe('string.braced');
    });
});
