import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

interface SemanticTokenScopes {
    language: string;
    scopes: Record<string, string[]>;
}

interface Contributes {
    languages: { id: string }[];
    semanticTokenModifiers?: { id: string }[];
    semanticTokenScopes?: SemanticTokenScopes[];
}

const contributes = (JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
    contributes: Contributes;
}).contributes;

const verilogLanguages = contributes.languages.map((language) => language.id).filter((id) => /verilog/i.test(id));

describe('llg semantic token scope contribution', () => {
    it('covers every Verilog language id', () => {
        expect(verilogLanguages).toEqual(expect.arrayContaining(['systemverilog', 'verilog']));
    });

    it.each(verilogLanguages)('maps plain keywords and control flow separately for %s', (language) => {
        const entry = (contributes.semanticTokenScopes ?? []).find((scopes) => scopes.language === language);
        expect(entry).toBeDefined();

        // VS Code probes `keyword.control` for a bare `keyword`, which Dark+
        // paints as control flow; plain keywords need a non-control scope.
        const keyword = entry?.scopes['keyword'] ?? [];
        expect(keyword.length).toBeGreaterThan(0);
        for (const scope of keyword) {
            expect(scope.startsWith('keyword.')).toBe(true);
            expect(scope.startsWith('keyword.control')).toBe(false);
            // Dark+ colors these keyword.other scopes as control flow too.
            expect(scope).not.toMatch(/^keyword\.other\.(using|directive\.using|operator)\b/);
        }

        const controlFlow = entry?.scopes['keyword.controlFlow'] ?? [];
        expect(controlFlow.length).toBeGreaterThan(0);
        for (const scope of controlFlow) {
            expect(scope.startsWith('keyword.control')).toBe(true);
        }

        // Macros should look like directives; VS Code's default `macro`
        // scope (`entity.name.function.preprocessor`) is blue in Dark+.
        const macro = entry?.scopes['macro'] ?? [];
        expect(macro.length).toBeGreaterThan(0);
        for (const scope of macro) {
            expect(scope.startsWith('keyword.control')).toBe(true);
        }
    });

    it('declares the llg keyword modifiers', () => {
        const modifiers = (contributes.semanticTokenModifiers ?? []).map((modifier) => modifier.id);
        expect(modifiers).toEqual(
            expect.arrayContaining(['controlFlow', 'typeDefinition', 'direction', 'primitive', 'connectionLabel']),
        );
    });
});
