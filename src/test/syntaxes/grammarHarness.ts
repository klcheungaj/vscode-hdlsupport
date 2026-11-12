import { readFile } from 'fs/promises';
import * as path from 'path';
import { OnigScanner, OnigString, loadWASM } from 'vscode-oniguruma';
import { IGrammar, IRawGrammar, INITIAL, Registry, StateStack, parseRawGrammar } from 'vscode-textmate';

// js-yaml 3 ships no type declarations; this is the one call the tests use.
const { safeLoad } = require('js-yaml') as { safeLoad(text: string): unknown };

export interface ScopedToken {
    text: string;
    scopes: string[];
}

const syntaxDirectory = path.resolve(process.cwd(), 'syntaxes');

// The YAML sources are read directly so the tests do not depend on
// `npm run build:syntax` having regenerated the JSON.
const grammarFiles = new Map([
    ['source.systemverilog', 'systemverilog.tmLanguage.yaml'],
    ['source.vhdl', 'vhdl.tmLanguage.yaml'],
    ['source.tcl', 'tcl.tmLanguage.json'],
    ['source.sdc', 'sdc.tmLanguage.json'],
    ['source.xdc', 'xdc.tmLanguage.json'],
]);

async function loadRawGrammar(scopeName: string): Promise<IRawGrammar | null> {
    const fileName = grammarFiles.get(scopeName);
    if (fileName === undefined) {
        return null;
    }
    const grammarPath = path.join(syntaxDirectory, fileName);
    const text = await readFile(grammarPath, 'utf8');
    return fileName.endsWith('.yaml') ? (safeLoad(text) as IRawGrammar) : parseRawGrammar(text, grammarPath);
}

let registry: Promise<Registry> | undefined;

function grammarRegistry(): Promise<Registry> {
    registry ??= (async () => {
        const wasm = await readFile(require.resolve('vscode-oniguruma/release/onig.wasm'));
        await loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
        return new Registry({
            onigLib: Promise.resolve({
                createOnigScanner: (patterns) => new OnigScanner(patterns),
                createOnigString: (value) => new OnigString(value),
            }),
            loadGrammar: loadRawGrammar,
        });
    })();
    return registry;
}

/** Tokenizes `lines` as one document and returns each line's tokens. */
export async function tokenize(scopeName: string, lines: string[]): Promise<ScopedToken[][]> {
    const grammar: IGrammar | null = await (await grammarRegistry()).loadGrammar(scopeName);
    if (grammar === null) {
        throw new Error(`grammar ${scopeName} did not load`);
    }
    let ruleStack: StateStack = INITIAL;
    return lines.map((line) => {
        const result = grammar.tokenizeLine(line, ruleStack);
        ruleStack = result.ruleStack;
        return result.tokens.map((token) => ({
            text: line.slice(token.startIndex, token.endIndex),
            scopes: token.scopes,
        }));
    });
}

export function tokensWithScope(lines: ScopedToken[][], scope: string): ScopedToken[] {
    return lines.flat().filter((token) => token.scopes.includes(scope));
}

/** The first token whose text is exactly `text`. */
export function tokenWithText(lines: ScopedToken[][], text: string): ScopedToken {
    const token = lines.flat().find((candidate) => candidate.text === text);
    if (token === undefined) {
        throw new Error(`no token ${JSON.stringify(text)} in ${JSON.stringify(lines.flat().map((t) => t.text))}`);
    }
    return token;
}

export function tokenContainingText(lines: ScopedToken[][], text: string): ScopedToken {
    const token = lines.flat().find((candidate) => candidate.text.includes(text));
    if (token === undefined) {
        throw new Error(`expected a token containing ${JSON.stringify(text)}`);
    }
    return token;
}

/** The innermost scope of a token, below the grammar's root scope. */
export function innermostScope(token: ScopedToken): string | undefined {
    return token.scopes.length > 1 ? token.scopes[token.scopes.length - 1] : undefined;
}
