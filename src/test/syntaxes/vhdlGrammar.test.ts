import { describe, expect, it } from 'vitest';

import { innermostScope, tokenize, tokenWithText, tokensWithScope } from './grammarHarness';

const VHDL = 'source.vhdl';

describe('VHDL TextMate grammar', () => {
    it('names design units, declarations, labels and library items', async () => {
        const lines = await tokenize(VHDL, [
            'library ieee;',
            'use ieee.numeric_std.all;',
            'entity counter is',
            '  generic (WIDTH : natural := 8);',
            '  port (clk : in std_logic; q : out unsigned(WIDTH-1 downto 0));',
            'end entity counter;',
            'architecture rtl of counter is',
            '  type state_t is (IDLE, RUN);',
            '  signal cnt, nxt : unsigned(WIDTH-1 downto 0);',
            '  function inc(x : unsigned) return unsigned is',
            '  begin return x + 1; end function inc;',
            'begin',
            '  tick : process (clk) begin',
            "    if rising_edge(clk) then cnt <= inc(cnt); end if;",
            '  end process tick;',
            '  u0 : entity work.sub port map (a => cnt(0));',
            'end rtl;',
        ]);
        const scope = (text: string, occurrence = 0): string | undefined =>
            innermostScope(lines.flat().filter((token) => token.text === text)[occurrence]);

        expect(scope('ieee')).toBe('entity.name.section.vhdl');
        expect(scope('all')).toBe('keyword.reserved.vhdl');
        expect(scope('counter')).toBe('entity.name.type.vhdl');
        expect(scope('counter', 1)).toBe('entity.name.type.vhdl');
        expect(scope('rtl')).toBe('entity.name.type.vhdl');
        expect(scope('counter', 2)).toBe('entity.other.inherited-class.vhdl');
        expect(scope('state_t')).toBe('entity.name.type.vhdl');
        expect(scope('IDLE')).toBe('entity.name.type.vhdl');
        expect(scope('natural')).toBe('entity.name.type.vhdl');
        expect(scope('std_logic')).toBe('entity.name.type.vhdl');
        expect(scope('cnt')).toBe('entity.name.variable.vhdl');
        expect(scope('nxt')).toBe('entity.name.variable.vhdl');
        expect(scope('inc')).toBe('entity.name.function.vhdl');
        expect(scope('inc', 1)).toBe('entity.name.function.vhdl');
        expect(scope('rising_edge')).toBe('support.function.vhdl');
        expect(scope('tick')).toBe('entity.name.tag.vhdl');
        expect(scope('tick', 1)).toBe('entity.name.tag.vhdl');
        expect(scope('u0')).toBe('entity.name.tag.vhdl');
        expect(scope('a')).toBe('variable.parameter.vhdl');
        expect(scope('if')).toBe('keyword.reserved.vhdl');
        // A bare `end name;` may close anything, so its name stays neutral.
        expect(scope('rtl', 1)).toBeUndefined();
    });

    it('tokenizes literals, attributes and comments', async () => {
        const lines = await tokenize(VHDL, [
            "x <= x\"FF\" when s'event and v = 16#1F# else '0'; -- comment",
            "y <= std_logic_vector'(\"10\"); /* block",
            '   comment */ z <= 1.5e3 - 1;',
        ]);
        expect(tokensWithScope(lines, 'constant.numeric.bit_string_literal.vhdl').map((t) => t.text)).toEqual(['x"FF"']);
        expect(tokensWithScope(lines, 'constant.numeric.based_literal.vhdl').map((t) => t.text)).toEqual(['16#1F#']);
        expect(innermostScope(tokenWithText(lines, 'event'))).toBe('variable.annotation.vhdl');
        expect(innermostScope(tokenWithText(lines, "'0'"))).toBe('string.quoted.single.vhdl');
        expect(innermostScope(tokenWithText(lines, 'std_logic_vector'))).toBe('entity.name.type.vhdl');
        expect(innermostScope(tokenWithText(lines, '-- comment'))).toBe('comment.line.vhdl');
        expect(tokensWithScope(lines, 'comment.block.vhdl').map((t) => t.text).join('')).toBe('/* block   comment */');
        // `- 1` is a subtraction, not a negative literal.
        expect(innermostScope(tokenWithText([lines[2]], '-'))).toBe('keyword.operator.vhdl');
    });

    it('keeps an unfinished construct from changing the rest of the file', async () => {
        const lines = await tokenize(VHDL, ['process (clk) is', '  if a then', 'signal s : bit;']);
        expect(tokenWithText(lines, 's').scopes).toEqual(['source.vhdl', 'entity.name.variable.vhdl']);
        expect(tokenWithText(lines, 'bit').scopes).toEqual(['source.vhdl', 'entity.name.type.vhdl']);
    });
});
