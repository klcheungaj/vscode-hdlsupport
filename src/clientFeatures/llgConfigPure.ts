// SPDX-License-Identifier: MIT

export interface LlgConfigField {
    key: string;
    detail: string;
    insertText: string;
    values?: readonly string[];
    isPathArray?: boolean;
}

export const LLG_CONFIG_SCHEMA: Readonly<Record<string, readonly LlgConfigField[]>> = {
    root: [
        { key: 'schema_version', detail: 'Configuration schema version; currently 1.', insertText: 'schema_version = 1' },
    ],
    sources: [
        { key: 'directories', detail: 'Source directories, relative to llg.toml.', insertText: 'directories = ["${1:rtl}"]', isPathArray: true },
        { key: 'include', detail: 'Root-relative source include globs.', insertText: 'include = ["${1:**/*.v}", "${2:**/*.sv}"]' },
        { key: 'exclude', detail: 'Source globs excluded from analysis.', insertText: 'exclude = ["${1:**/generated/**}"]' },
    ],
    compile: [
        { key: 'top', detail: 'Optional elaboration top module.', insertText: 'top = "${1:top}"' },
        { key: 'include_dirs', detail: 'Additional include-search directories.', insertText: 'include_dirs = ["${1:include}"]', isPathArray: true },
        { key: 'defines', detail: 'Preprocessor NAME or NAME=VALUE definitions.', insertText: 'defines = ["${1:SYNTHESIS}"]' },
    ],
    'compile.param_overrides': [
        { key: 'NAME', detail: 'Top-level parameter override.', insertText: '${1:WIDTH} = ${2:8}' },
    ],
    analysis: [
        { key: 'max_file_bytes', detail: 'Maximum UTF-8 bytes admitted for one input.', insertText: 'max_file_bytes = 1048576' },
        { key: 'max_total_input_bytes', detail: 'Maximum total bytes admitted for one analysis.', insertText: 'max_total_input_bytes = 8388608' },
    ],
    lint: [
        { key: 'enabled', detail: 'Globally enable or disable built-in lint rules.', insertText: 'enabled = ${1|true,false|}', values: ['true', 'false'] },
    ],
    'lint.rule': [
        { key: 'enabled', detail: 'Enable this lint rule.', insertText: 'enabled = ${1|true,false|}', values: ['true', 'false'] },
        { key: 'severity', detail: 'Diagnostic severity for this rule.', insertText: 'severity = "${1|error,warning,info|}"', values: ['error', 'warning', 'info'] },
    ],
};

/** Built-in Lapligence lint rule ids, in the server registry's stable order. */
export const LLG_LINT_RULES = [
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
] as const;

export const LLG_CONFIG_SECTIONS = [
    'sources',
    'compile',
    'compile.param_overrides',
    'analysis',
    'lint',
    ...LLG_LINT_RULES.map((rule) => `lint.rules.${rule}` as const),
] as const;

export function activeTomlSection(textBeforePosition: string): string {
    const matches = [...textBeforePosition.matchAll(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/gm)];
    return matches.length === 0 ? 'root' : matches[matches.length - 1][1].trim();
}

export function fieldsForSection(section: string): readonly LlgConfigField[] {
    if (/^lint\.rules\.[A-Za-z0-9-]+$/.test(section)) {
        return LLG_CONFIG_SCHEMA['lint.rule'];
    }
    return LLG_CONFIG_SCHEMA[section] ?? [];
}

export function configField(section: string, key: string): LlgConfigField | undefined {
    return fieldsForSection(section).find((field) => field.key === key);
}

export function keyOnLine(line: string): string | undefined {
    return /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line)?.[1];
}

export function quotedPathPrefix(textBeforeCursor: string): string | undefined {
    const lines = textBeforeCursor.split(/\r?\n/);
    let assignmentLine = lines.length - 1;
    while (assignmentLine >= 0 && !keyOnLine(lines[assignmentLine])) {
        if (/^\s*\[/.test(lines[assignmentLine])) {
            return undefined;
        }
        assignmentLine -= 1;
    }
    if (assignmentLine < 0) {
        return undefined;
    }
    const assignment = lines.slice(assignmentLine).map(stripTomlComment).join('\n');
    const key = keyOnLine(assignment);
    if (!key || !['directories', 'include_dirs'].includes(key)) {
        return undefined;
    }
    const value = assignment.slice(assignment.indexOf('=') + 1);
    if (!value.trimStart().startsWith('[') || arrayBracketBalance(value) <= 0) {
        return undefined;
    }
    let quoteStart = -1;
    let quoteCharacter = '';
    let isEscaped = false;
    for (let index = assignment.indexOf('=') + 1; index < assignment.length; index++) {
        const character = assignment[index];
        if (quoteStart >= 0) {
            if (quoteCharacter === '"' && character === '\\' && !isEscaped) {
                isEscaped = true;
                continue;
            }
            if (character === quoteCharacter && !isEscaped) {
                quoteStart = -1;
                quoteCharacter = '';
            }
            isEscaped = false;
        } else if (character === '"' || character === "'") {
            quoteStart = index;
            quoteCharacter = character;
        } else if (character === '#') {
            break;
        }
    }
    return quoteStart >= 0 ? assignment.slice(quoteStart + 1) : undefined;
}

function stripTomlComment(line: string): string {
    let quote = '';
    let isEscaped = false;
    for (let index = 0; index < line.length; index++) {
        const character = line[index];
        if (quote !== '') {
            if (quote === '"' && character === '\\' && !isEscaped) {
                isEscaped = true;
                continue;
            }
            if (character === quote && !isEscaped) {
                quote = '';
            }
            isEscaped = false;
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '#') {
            return line.slice(0, index);
        }
    }
    return line;
}

function arrayBracketBalance(text: string): number {
    let balance = 0;
    let quote = '';
    let isEscaped = false;
    for (const character of text) {
        if (quote !== '') {
            if (quote === '"' && character === '\\' && !isEscaped) {
                isEscaped = true;
                continue;
            }
            if (character === quote && !isEscaped) {
                quote = '';
            }
            isEscaped = false;
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '[') {
            balance += 1;
        } else if (character === ']') {
            balance -= 1;
        }
    }
    return balance;
}

function literalTomlStrings(text: string): string[] {
    const result: string[] = [];
    const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
    for (const match of text.matchAll(pattern)) {
        const basic = match[1];
        result.push(basic === undefined
            ? match[2]
            : basic.replace(/\\(["\\])/g, '$1'));
    }
    return result;
}

/** Extracts literal path arrays from [sources] and [compile] without general TOML parsing. */
export function extractLlgSearchDirectories(text: string): Array<{ section: string; path: string }> {
    const result: Array<{ section: string; path: string }> = [];
    let section = 'root';
    let pending: { section: string; value: string; balance: number } | undefined;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = stripTomlComment(rawLine);
        if (pending) {
            pending.value += `\n${line}`;
            pending.balance += arrayBracketBalance(line);
            if (pending.balance <= 0) {
                for (const path of literalTomlStrings(pending.value)) {
                    result.push({ section: pending.section, path });
                }
                pending = undefined;
            }
            continue;
        }
        const sectionMatch = /^\s*\[([^\]]+)\]/.exec(line);
        if (sectionMatch) {
            section = sectionMatch[1].trim();
            continue;
        }
        const key = keyOnLine(line);
        if (!((section === 'sources' && key === 'directories') || (section === 'compile' && key === 'include_dirs'))) {
            continue;
        }
        const value = line.slice(line.indexOf('=') + 1);
        if (!value.trimStart().startsWith('[')) {
            continue;
        }
        const balance = arrayBracketBalance(value);
        if (balance > 0) {
            pending = { section, value, balance };
            continue;
        }
        for (const path of literalTomlStrings(value)) {
            result.push({ section, path });
        }
    }
    return result;
}
