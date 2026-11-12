// SPDX-License-Identifier: MIT
//
// Pure model for the HDL Modules explorer: module records in, instantiation
// hierarchy out. This file must stay free of `import ... from 'vscode'` so it
// loads (and is unit-tested) in plain Node - jest has no vscode mock.
//
// The symbol-kind numbers used below are the LSP wire values, the same space
// `classifyModuleChildren` in src/commands/ModuleInstantiation.ts operates on:
// lapligence/src/bin/llg_ls/features.rs sym_kind_to_lsp maps Module -> MODULE (2),
// Port -> PROPERTY (7), Net|Var -> VARIABLE (13), Param -> CONSTANT (14) and
// Instance -> OBJECT (19). Callers that hold vscode.DocumentSymbol objects
// (whose SymbolKind enum numbering is the LSP numbering minus one) shift the
// kinds by +1 before handing them over, exactly like `toLspChildren` does in
// ModuleInstantiation.ts.

/** Zero-based LSP-style position range, kept as plain data. */
export interface SourceRange {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
}

/** A port, parameter, or signal/variable child of a module. */
export interface ClassifiedChild {
    name: string;
    detail?: string;
    /** Resolved value, retained for test inspection and future consumers. */
    value?: string;
    /** Explicit server-provided display text, when available. */
    resolvedDisplayType?: string;
    /** Declaration location for Module Contents navigation. */
    uri?: string;
    range?: SourceRange;
}

/** The source of the declarations shown for one hierarchy entry. */
export type ModuleContentSource = 'elaborated' | 'declaration';

/** Optional declaration/content payload shared by roots and instance nodes. */
export interface HierarchyContents {
    ports?: ClassifiedChild[];
    params?: ClassifiedChild[];
    signals?: ClassifiedChild[];
    contentSource?: ModuleContentSource;
    /** True when the module type could not be mapped to one definition. */
    isAmbiguousDefinition?: boolean;
}

/**
 * Optional response-wide output budget supplied by the client fallback.
 * Keeping this as callbacks avoids coupling the pure hierarchy model to the
 * snapshot normalizer while allowing roots, expanded nodes, and copied
 * contents to consume one shared response budget.
 */
export interface HierarchyBuildBudget {
    takeRootSlot(): boolean;
    takeNodeSlot(): boolean;
    takeContentSlot(): boolean;
    noteTruncation(): void;
    markTruncationAttached(): void;
}

/** One instantiation site found inside a module body. */
export interface InstanceRecord {
    instanceName: string;
    /** Instantiated module type; undefined when it could not be determined. */
    moduleType?: string;
    /** Server-owned definition identity, when available. */
    definitionId?: string;
    /** Source location of the instantiation site, when available. */
    uri?: string;
    range?: SourceRange;
}

/** One discovered module definition, flattened from document symbols. */
export interface ModuleRecord {
    /** Server-owned stable definition identity, when available. */
    id?: string;
    name: string;
    uri: string;
    range?: SourceRange;
    ports?: ClassifiedChild[];
    params?: ClassifiedChild[];
    signals?: ClassifiedChild[];
    contentSource?: ModuleContentSource;
    isAmbiguousDefinition?: boolean;
    instances: InstanceRecord[];
}

/** Raw document-symbol child as consumed by the classifier. */
export interface RawSymbolChild {
    name: string;
    kind: number;
    detail?: string;
    uri?: string;
    range?: SourceRange;
}

export interface ClassifiedModuleChildren {
    ports: ClassifiedChild[];
    params: ClassifiedChild[];
    signals: ClassifiedChild[];
    instances: InstanceRecord[];
}

const LSP_SYMBOL_KIND_PROPERTY = 7;
const LSP_SYMBOL_KIND_VARIABLE = 13;
const LSP_SYMBOL_KIND_CONSTANT = 14;
const LSP_SYMBOL_KIND_OBJECT = 19;

// Mirrors PARAMETER_DETAIL_PREFIXES in src/commands/ModuleInstantiation.ts:
// llg renders parameter details like "parameter int WIDTH = 8" or
// "localparam int DEPTH = 4", so those prefixes identify parameters even when
// a server picks an unexpected symbol kind.
const PARAMETER_DETAIL_PREFIXES = ['parameter', 'localparam'];

const IDENTIFIER_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*/;
const IDENTIFIER_FULL_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Hard cap on module expansions per hierarchy root. expandInstances clones the
 * ancestor path per branch, so N double-instantiations would visit 2^N nodes;
 * once the budget is spent, deeper modules become leaves flagged
 * isBudgetTruncated (same handling as cycle truncation).
 */
export const MAX_EXPANDED_NODES = 5000;

function isParameterLike(kind: number, detail?: string): boolean {
    return (
        kind === LSP_SYMBOL_KIND_CONSTANT ||
        PARAMETER_DETAIL_PREFIXES.some((prefix) => detail !== undefined && detail.startsWith(prefix))
    );
}

function classifiedChild(child: RawSymbolChild, detail?: string): ClassifiedChild {
    return {
        name: child.name,
        ...(detail !== undefined ? { detail } : {}),
        ...(child.uri ? { uri: child.uri } : {}),
        ...(child.range ? { range: child.range } : {}),
    };
}

/**
 * Best-effort extraction of the instantiated module type for an Object-kind
 * (instance) document-symbol child. Preference order:
 * 1. the detail text, stripped of parameter overrides at '#' (e.g.
 *    "counter #(.WIDTH(8))" -> "counter"), with a "pkg::name" scope prefix removed;
 * 2. a "<instance> : <type>" style suffix of the symbol name.
 * A bare identifier name is treated as the INSTANCE name only - guessing a
 * type from it would risk inventing wrong hierarchy edges, so extraction gives
 * up (undefined) and callers bucket the instance as unresolved.
 */
export function extractInstantiatedType(name: string, detail?: string): string | undefined {
    if (detail) {
        let candidate = detail.split('#')[0].trim();
        const scopeSeparator = candidate.lastIndexOf('::');
        if (scopeSeparator >= 0) {
            candidate = candidate.substring(scopeSeparator + 2).trim();
        }
        const match = IDENTIFIER_PREFIX_PATTERN.exec(candidate);
        if (match) {
            return match[0];
        }
    }
    if (name.includes(':')) {
        const candidate = name.substring(name.lastIndexOf(':') + 1).trim();
        if (IDENTIFIER_FULL_PATTERN.test(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * Splits the children of a module document symbol into ports, parameters,
 * signals/variables and instances, mirroring classifyModuleChildren semantics:
 * Property (7) is a port, Constant (14) - or any child whose detail starts
 * with "parameter"/"localparam" - is a parameter, Variable (13) is a signal,
 * Object (19) is an instance and Module (2) marks a nested definition.
 * Children with unknown kinds contribute nothing to the grouping.
 */
export function classifyDocumentSymbolChildren(children: RawSymbolChild[]): ClassifiedModuleChildren {
    const result: ClassifiedModuleChildren = { ports: [], params: [], signals: [], instances: [] };
    for (const child of children ?? []) {
        if (!child || !child.name) {
            continue;
        }
        const detail = typeof child.detail === 'string' ? child.detail : undefined;
        switch (child.kind) {
            case LSP_SYMBOL_KIND_PROPERTY:
                if (isParameterLike(child.kind, detail)) {
                    result.params.push(classifiedChild(child, detail));
                } else {
                    result.ports.push(classifiedChild(child, detail));
                }
                break;
            case LSP_SYMBOL_KIND_CONSTANT:
                result.params.push(classifiedChild(child, detail));
                break;
            case LSP_SYMBOL_KIND_VARIABLE:
                if (isParameterLike(child.kind, detail)) {
                    result.params.push(classifiedChild(child, detail));
                } else {
                    result.signals.push(classifiedChild(child, detail));
                }
                break;
            case LSP_SYMBOL_KIND_OBJECT:
                result.instances.push({
                    instanceName: child.name,
                    moduleType: extractInstantiatedType(child.name, detail),
                    ...(child.uri ? { uri: child.uri } : {}),
                    ...(child.range ? { range: child.range } : {}),
                });
                break;
            default:
                // Unknown kinds (nested definitions, typedefs, functions, ...)
                // are intentionally not part of the ports/params/signals view.
                break;
        }
    }
    return result;
}

/** One expandable node of the instantiation hierarchy tree. */
export interface HierarchyNode extends HierarchyContents {
    /** Server-owned stable hierarchy identity, when available. */
    id?: string;
    /** Instance name; absent only on the synthetic "(unresolved)" group. */
    instanceName?: string;
    /** Instantiated module type; absent when it could not be resolved. */
    moduleType?: string;
    /** Server-owned definition identity, when available. */
    definitionId?: string;
    uri?: string;
    range?: SourceRange;
    /** True for the synthetic group holding instances of unknown type. */
    isUnresolvedGroup?: boolean;
    /** True for a generated scope wrapper from a server snapshot. */
    isGenerateScope?: boolean;
    /** True when expansion stopped here because moduleType is already on the path. */
    isCycleTruncated?: boolean;
    /**
     * True when expansion stopped here because MAX_EXPANDED_NODES was spent,
     * mirroring isCycleTruncated handling so diamond-heavy hierarchies stay
     * renderable instead of blowing up exponentially.
     */
    isBudgetTruncated?: boolean;
    children: HierarchyNode[];
}

/** A top-level root of the instantiation hierarchy (an uninstantiated module). */
export interface HierarchyRoot extends HierarchyContents {
    /** Server-owned stable hierarchy identity, when available. */
    id?: string;
    /** Server-owned definition identity, when available. */
    definitionId?: string;
    /** True only for the synthetic root grouping cycles with no normal root. */
    isSyntheticGroup?: boolean;
    name: string;
    uri?: string;
    range?: SourceRange;
    /** True when the client stopped building this response at its budget. */
    isBudgetTruncated?: boolean;
    children: HierarchyNode[];
}

/** One module definition discovered through a symbol provider. */
export interface WorkspaceModuleRef {
    name: string;
    /** Stringified uri of the file holding the definition. */
    uri: string;
}

/** A vscode quick-pick item describing one workspace module definition. */
export interface ModuleQuickPickItem extends WorkspaceModuleRef {
    label: string;
    /** Workspace-relative display path of the defining file. */
    detail: string;
    /** Set only when several files define the same module name. */
    description?: string;
}

// vscode.SymbolKind.Module is 1, but some servers leak raw LSP kinds where
// Module is 2; accept both when spotting declarations (same defensive check
// as isModuleKind in src/hierarchy/moduleExplorer.ts).
const VSCODE_SYMBOL_KIND_MODULE = 1;
const RAW_LSP_SYMBOL_KIND_MODULE = 2;

/**
 * True for symbol kinds that identify a module DEFINITION, accepting both the
 * vscode SymbolKind numbering (Module = 1) and the raw LSP wire value (2) that
 * some providers leak.
 */
export function isModuleSymbolKind(kind: number): boolean {
    return kind === VSCODE_SYMBOL_KIND_MODULE || kind === RAW_LSP_SYMBOL_KIND_MODULE;
}

/** Strips a leading "./" from a relative display path ("./rtl/a.v" -> "rtl/a.v"). */
export function cleanDisplayPath(displayPath: string): string {
    return displayPath.startsWith('./') ? displayPath.slice(2) : displayPath;
}

/**
 * SystemVerilog words that can legitimately END a type-only detail text
 * (`inout wire`, `input logic`, `unsigned int`).  A trailing token from this
 * set is a type word, never the declared NAME, so it survives stripping.
 */
const SV_TYPE_KEYWORDS = new Set([
    'input', 'output', 'inout',
    'logic', 'bit', 'reg', 'wire', 'tri', 'triand', 'trior', 'tri0', 'tri1',
    'trireg', 'uwire', 'wand', 'wor',
    'int', 'integer', 'longint', 'shortint', 'byte', 'time',
    'real', 'shortreal', 'realtime', 'string', 'signed', 'unsigned',
    'enum', 'struct', 'union', 'class', 'array', 'event', 'chandle', 'void',
    'const', 'var', 'ref', 'buffer', 'linkage', 'typedef',
]);

// These are source-level qualifiers, not redundant direction words. Keep
// them (and a following user-defined type) when the caller has no declaration
// name metadata with which to distinguish a legacy trailing name.
const PRESERVED_TYPE_QUALIFIERS = new Set(['const', 'var', 'ref', 'buffer', 'linkage', 'typedef']);

// Keyword operators can need a readable separator next to punctuation too;
// for example, the server contract keeps `inside { ... }` spaced.
const DIMENSION_KEYWORD_OPERATORS = new Set(['inside']);

// Removing whitespace is safe only when it cannot make the surrounding
// characters lex as a different token. Comment delimiters are included
// because a dimension detail must never accidentally turn two ordinary
// slash/star tokens into a comment. The crossing-boundary check below tests
// every possible split of these lexemes, so it also protects a longer token
// when the whitespace occurs after its first two characters (`== ?` -> `==?`).
const MULTI_CHARACTER_LEXEMES = [
    '++', '--', '**', '&&', '&&&', '||', '|||', '^^',
    '==', '!=', '===', '!==', '==?', '!=?',
    '<=', '>=', '<<', '>>', '<<<', '>>>',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
    '<<=', '>>=', '<<<=', '>>>=',
    '->', '=>', '::', '.*', '~&', '~|', '~^', '^~',
    '##', ':=', ':/',
    '|->', '|=>', '#-#', '#=#',
    '//', '/*', '*/',
];
const MULTI_CHARACTER_LEXEME_PREFIXES = new Set(
    MULTI_CHARACTER_LEXEMES.map((lexeme) => lexeme.slice(0, 2)),
);

const PORT_DIRECTION_PATTERN = /^(?:input|output|inout)\b\s*/i;

/**
 * Normalizes text shown in the Module Contents view without changing the
 * meaningful spelling of a SystemVerilog type.  In particular, whitespace
 * around packed dimensions is presentation-only and is made deterministic.
 */
export function normalizeContentsDisplayText(value: string): string {
    let normalized = '';
    let bracketDepth = 0;
    let inString = false;
    let escapedStringCharacter = false;
    let inEscapedIdentifier = false;
    let inLineComment = false;
    let inBlockComment = false;
    let preserveCommentBoundaryWhitespace = false;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];

        if (inLineComment) {
            normalized += character;
            if (character === '\n' || (character === '\r' && value[index + 1] !== '\n')) {
                inLineComment = false;
                preserveCommentBoundaryWhitespace = true;
            }
            continue;
        }

        if (inBlockComment) {
            normalized += character;
            if (character === '*' && value[index + 1] === '/') {
                normalized += '/';
                index += 1;
                inBlockComment = false;
                preserveCommentBoundaryWhitespace = true;
            }
            continue;
        }

        if (inString) {
            normalized += character;
            if (escapedStringCharacter) {
                escapedStringCharacter = false;
            } else if (character === '\\') {
                escapedStringCharacter = true;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }

        if (inEscapedIdentifier) {
            if (/\s/.test(character)) {
                inEscapedIdentifier = false;
            } else {
                normalized += character;
                continue;
            }
        }

        if (character === '"') {
            normalized += character;
            inString = true;
            preserveCommentBoundaryWhitespace = false;
            continue;
        }

        if (character === '/' && value[index + 1] === '/') {
            normalized += '//';
            index += 1;
            inLineComment = true;
            preserveCommentBoundaryWhitespace = false;
            continue;
        }

        if (character === '/' && value[index + 1] === '*') {
            normalized += '/*';
            index += 1;
            inBlockComment = true;
            preserveCommentBoundaryWhitespace = false;
            continue;
        }

        if (character === '\\' && isEscapedIdentifierStart(value, index)) {
            normalized += character;
            inEscapedIdentifier = true;
            preserveCommentBoundaryWhitespace = false;
            continue;
        }

        if (/\s/.test(character)) {
            const whitespaceEnd = skipWhitespace(value, index);
            if ((startsComment(value, whitespaceEnd) && normalized.length > 0) ||
                (preserveCommentBoundaryWhitespace && whitespaceEnd < value.length)) {
                normalized += value.slice(index, whitespaceEnd);
                preserveCommentBoundaryWhitespace = false;
                index = whitespaceEnd - 1;
                continue;
            }
            const next = nextNonWhitespaceCharacter(value, whitespaceEnd);
            if (bracketDepth > 0) {
                // Match the server's symbolic-expression normalization:
                // punctuation and operators are compacted, but adjacent
                // word-like tokens retain the separator they need, e.g.
                // `[P inside {1,2}:0]`.
                if (needsDimensionSeparator(normalized, value, whitespaceEnd, next)) {
                    normalized += ' ';
                }
            } else if ((normalized.length > 0 && next !== undefined && !normalized.endsWith(' ')) ||
                needsLexicalSeparator(normalized, value, whitespaceEnd, next)) {
                normalized += ' ';
            }
            index = whitespaceEnd - 1;
            continue;
        }

        if (character === '[') {
            normalized += character;
            bracketDepth += 1;
            preserveCommentBoundaryWhitespace = false;
            continue;
        }

        if (character === ']') {
            normalized += character;
            bracketDepth = Math.max(0, bracketDepth - 1);
            preserveCommentBoundaryWhitespace = false;
            continue;
        }

        normalized += character;
        preserveCommentBoundaryWhitespace = false;
    }

    return normalized;
}

function startsComment(value: string, start: number): boolean {
    return value[start] === '/' && (value[start + 1] === '/' || value[start + 1] === '*');
}

function isEscapedIdentifierStart(value: string, index: number): boolean {
    return index === 0 || !isDisplayWordCharacter(value[index - 1]);
}

function nextNonWhitespaceCharacter(value: string, start: number): string | undefined {
    for (let index = start; index < value.length; index += 1) {
        if (!/\s/.test(value[index])) {
            return value[index];
        }
    }
    return undefined;
}

function skipWhitespace(value: string, start: number): number {
    let index = start;
    while (index < value.length && /\s/.test(value[index])) {
        index += 1;
    }
    return index;
}

function isDisplayWordCharacter(character: string | undefined): boolean {
    return character !== undefined && /[A-Za-z0-9_$]/.test(character);
}

function previousNonWhitespaceCharacter(value: string, start: number): string | undefined {
    for (let index = start; index >= 0; index -= 1) {
        if (!/\s/.test(value[index])) {
            return value[index];
        }
    }
    return undefined;
}

function isEscapedIdentifierAtEnd(value: string): boolean {
    let inString = false;
    let escapedStringCharacter = false;
    let inEscapedIdentifier = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];

        if (inLineComment) {
            if (character === '\n' || (character === '\r' && value[index + 1] !== '\n')) {
                inLineComment = false;
            }
            continue;
        }

        if (inBlockComment) {
            if (character === '*' && value[index + 1] === '/') {
                index += 1;
                inBlockComment = false;
            }
            continue;
        }

        if (inString) {
            if (escapedStringCharacter) {
                escapedStringCharacter = false;
            } else if (character === '\\') {
                escapedStringCharacter = true;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }

        if (character === '"') {
            inString = true;
            continue;
        }

        if (inEscapedIdentifier) {
            if (/\s/.test(character)) {
                inEscapedIdentifier = false;
            }
            continue;
        }

        if (character === '/' && value[index + 1] === '/') {
            index += 1;
            inLineComment = true;
            continue;
        }

        if (character === '/' && value[index + 1] === '*') {
            index += 1;
            inBlockComment = true;
            continue;
        }

        if (character === '\\' &&
            isEscapedIdentifierStart(value, index)) {
            inEscapedIdentifier = true;
        }
    }

    return inEscapedIdentifier;
}

function needsDimensionSeparator(
    normalized: string,
    value: string,
    whitespaceEnd: number,
    next: string | undefined,
): boolean {
    return needsLexicalSeparator(normalized, value, whitespaceEnd, next) ||
        isAdjacentToDimensionKeyword(normalized, value, whitespaceEnd);
}

function needsLexicalSeparator(
    normalized: string,
    value: string,
    whitespaceEnd: number,
    next: string | undefined,
): boolean {
    // A whitespace run is handled as one unit. This guard also keeps a
    // preserved separator from growing if the caller changes the scan loop.
    if (normalized.endsWith(' ') || next === undefined) {
        return false;
    }

    const previous = normalized[normalized.length - 1];

    // Adjacent word tokens would otherwise merge into a different identifier
    // or number. An escaped identifier has an additional rule: its required
    // terminating whitespace is part of the token boundary even when the
    // following token is punctuation.
    if ((isDisplayWordCharacter(previous) && isDisplayWordCharacter(next)) ||
        isEscapedIdentifierAtEnd(normalized)) {
        return true;
    }

    // Keep any boundary that could form a compound operator or comment
    // delimiter. This covers ++/-- as well as logical/reduction pairs such as
    // `& &`, `| |`, and `^ ^`; compacting those would change the expression.
    if (MULTI_CHARACTER_LEXEME_PREFIXES.has(`${previous}${next}`) ||
        crossesMultiCharacterLexeme(normalized, value, whitespaceEnd)) {
        return true;
    }

    // A digit separated from a dot can become a real-number literal when the
    // whitespace is removed (`1 . 0` -> `1.0`). Likewise, a sized literal's
    // apostrophe must not be fused to its surrounding digits/letters.
    if (isNumericLexicalBoundary(normalized, previous, next)) {
        return true;
    }

    return false;
}

function crossesMultiCharacterLexeme(
    normalized: string,
    value: string,
    whitespaceEnd: number,
): boolean {
    const leftStart = normalized.search(/\S+$/);
    const left = leftStart >= 0 ? normalized.slice(leftStart) : '';
    let rightEnd = whitespaceEnd;
    while (rightEnd < value.length && !/\s/.test(value[rightEnd])) {
        rightEnd += 1;
    }
    const right = value.slice(whitespaceEnd, rightEnd);

    for (const lexeme of MULTI_CHARACTER_LEXEMES) {
        for (let split = 1; split < lexeme.length; split += 1) {
            if (left.endsWith(lexeme.slice(0, split)) && right.startsWith(lexeme.slice(split))) {
                return true;
            }
        }
    }
    return false;
}

function isNumericLexicalBoundary(
    normalized: string,
    previous: string,
    next: string,
): boolean {
    const beforePrevious = previousNonWhitespaceCharacter(normalized, normalized.length - 2);
    if ((/[0-9]/.test(previous) && next === '.') ||
        (previous === '.' && isDisplayWordCharacter(next) && /[0-9]/.test(beforePrevious ?? ''))) {
        return true;
    }

    if (next === "'" && /[0-9]/.test(previous)) {
        return true;
    }
    if (previous === "'" && isDisplayWordCharacter(next) &&
        /[0-9]/.test(beforePrevious ?? '')) {
        return true;
    }
    return false;
}

function isAdjacentToDimensionKeyword(normalized: string, value: string, start: number): boolean {
    const previousWord = normalized.match(/[A-Za-z0-9_$]+$/)?.[0];
    const nextWord = nextDisplayWord(value, start);
    return (previousWord !== undefined && DIMENSION_KEYWORD_OPERATORS.has(previousWord))
        || (nextWord !== undefined && DIMENSION_KEYWORD_OPERATORS.has(nextWord));
}

function nextDisplayWord(value: string, start: number): string | undefined {
    let index = start;
    while (index < value.length && /\s/.test(value[index])) {
        index += 1;
    }
    const wordStart = index;
    while (index < value.length && isDisplayWordCharacter(value[index])) {
        index += 1;
    }
    return index > wordStart ? value.slice(wordStart, index) : undefined;
}

function stripPortDirection(value: string): string {
    return value.replace(PORT_DIRECTION_PATTERN, '').trim();
}

interface IdentifierSpan {
    start: number;
    end: number;
    text: string;
}

function identifierSpansOutsideBrackets(value: string): IdentifierSpan[] {
    const spans: IdentifierSpan[] = [];
    let bracketDepth = 0;
    let inString = false;
    let escapedStringCharacter = false;
    let inEscapedIdentifier = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < value.length;) {
        const character = value[index];

        if (inLineComment) {
            if (character === '\n' || (character === '\r' && value[index + 1] !== '\n')) {
                inLineComment = false;
            }
            index += 1;
            continue;
        }

        if (inBlockComment) {
            if (character === '*' && value[index + 1] === '/') {
                inBlockComment = false;
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }

        if (inString) {
            if (escapedStringCharacter) {
                escapedStringCharacter = false;
            } else if (character === '\\') {
                escapedStringCharacter = true;
            } else if (character === '"') {
                inString = false;
            }
            index += 1;
            continue;
        }

        if (inEscapedIdentifier) {
            if (/\s/.test(character)) {
                inEscapedIdentifier = false;
            }
            index += 1;
            continue;
        }

        if (character === '"') {
            inString = true;
            index += 1;
            continue;
        }
        if (character === '/' && value[index + 1] === '/') {
            inLineComment = true;
            index += 2;
            continue;
        }
        if (character === '/' && value[index + 1] === '*') {
            inBlockComment = true;
            index += 2;
            continue;
        }
        if (character === '\\' && isEscapedIdentifierStart(value, index)) {
            inEscapedIdentifier = true;
            index += 1;
            continue;
        }

        if (character === '[') {
            bracketDepth += 1;
            index += 1;
            continue;
        }
        if (character === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
            index += 1;
            continue;
        }
        if (bracketDepth === 0 && /[A-Za-z_]/.test(character)) {
            const start = index;
            index += 1;
            while (index < value.length && /[A-Za-z0-9_$]/.test(value[index])) {
                index += 1;
            }
            spans.push({ start, end: index, text: value.slice(start, index) });
            continue;
        }
        index += 1;
    }
    return spans;
}

function stripLegacyDeclarationName(value: string, name?: string): string {
    const spans = identifierSpansOutsideBrackets(value);
    if (spans.length === 0) {
        return value;
    }
    if (name === undefined && spans.length < 2) {
        return value;
    }

    if (name === undefined) {
        const withoutDirection = stripPortDirection(value);
        const firstWord = withoutDirection.match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0].toLowerCase();
        if (firstWord !== undefined && PRESERVED_TYPE_QUALIFIERS.has(firstWord)) {
            return value;
        }
    }

    // The normalized child carries the declaration name, so prefer its last
    // occurrence outside dimensions. This handles source-style unpacked
    // arrays (`logic [7:0] data [0:3]`) without dropping the suffix.
    const namedSpan = name === undefined
        ? undefined
        : [...spans].reverse().find((span) => span.text === name);
    const candidate = namedSpan ?? spans[spans.length - 1];
    if (SV_TYPE_KEYWORDS.has(candidate.text.toLowerCase())) {
        return value;
    }

    if (namedSpan === undefined) {
        const suffix = value.slice(candidate.end).trim();
        const hasOnlyUnpackedSuffix = suffix.length > 0 && suffix.startsWith('[');
        // Without the child metadata, an identifier followed by a dimension
        // is ambiguous: it may be a named typedef (`word_t [0:3]`) or a
        // declaration with an unpacked suffix. The normalizer always supplies
        // the child name, so preserve the ambiguous form rather than corrupt
        // a valid type-only display.
        if (hasOnlyUnpackedSuffix) {
            return value;
        }
    }

    if (name !== undefined && namedSpan === undefined) {
        return value;
    }
    return `${value.slice(0, candidate.start)}${value.slice(candidate.end)}`;
}

function isParameterDetail(value: string): boolean {
    return /^(parameter|localparam)\b/i.test(value);
}

/**
 * Description text for a Module Contents entry.  The optional child metadata
 * carries an authoritative resolved display string and value; when it is
 * absent, the legacy detail text remains the fallback.  Port direction words
 * are removed because the tree already groups ports by direction.
 */
export function contentsEntryDescription(
    detail?: string,
    child?: Pick<ClassifiedChild, 'resolvedDisplayType' | 'value'> & { name?: string },
): string | undefined {
    const resolvedDisplayType = child?.resolvedDisplayType;
    const preferred = resolvedDisplayType ?? detail;
    if (preferred === undefined) {
        return undefined;
    }
    let trimmed = normalizeContentsDisplayText(preferred);
    if (!trimmed) {
        return undefined;
    }

    // A future server may provide only the resolved type (`int`) alongside a
    // legacy parameter detail (`parameter int`). Keep the familiar keyword in
    // that mixed payload instead of turning the row into a bare type.
    if (child?.resolvedDisplayType && isParameterDetail(detail ?? '') && !isParameterDetail(trimmed)) {
        const keyword = (detail ?? '').match(/^(parameter|localparam)\b/i)?.[1];
        if (keyword) {
            trimmed = `${keyword} ${trimmed}`;
        }
    }

    if (isParameterDetail(trimmed)) {
        if (child?.value !== undefined && !trimmed.includes('=')) {
            trimmed = `${trimmed} = ${normalizeContentsDisplayText(child.value)}`;
        }
        return normalizeContentsDisplayText(trimmed);
    }

    // The server's resolved/type-display fields are type-only. They can end
    // in a user-defined type name (`word_t`, `enum state_t`) and therefore
    // must never go through the legacy trailing-name heuristic. Directions
    // are still presentation-only because the tree already groups ports by
    // direction.
    if (resolvedDisplayType !== undefined) {
        const withoutDirection = stripPortDirection(trimmed);
        return withoutDirection ? normalizeContentsDisplayText(withoutDirection) : undefined;
    }

    const withoutName = stripLegacyDeclarationName(trimmed, child?.name);
    const withoutDirection = stripPortDirection(withoutName);
    return withoutDirection ? normalizeContentsDisplayText(withoutDirection) : undefined;
}

/**
 * Module names that are defined in more than one distinct file.  Such names
 * are ambiguous for hierarchy display, so callers show the distinguishing
 * relative path next to them (same scheme as the instantiate QuickPick).
 */
export function ambiguousModuleNames(modules: ModuleRecord[]): Set<string> {
    const filesPerName = new Map<string, Set<string>>();
    for (const module of modules ?? []) {
        if (!module?.name || !module.uri) {
            continue;
        }
        let uris = filesPerName.get(module.name);
        if (!uris) {
            uris = new Set<string>();
            filesPerName.set(module.name, uris);
        }
        uris.add(module.uri);
    }
    const ambiguous = new Set<string>();
    for (const [name, uris] of filesPerName) {
        if (uris.size > 1) {
            ambiguous.add(name);
        }
    }
    return ambiguous;
}

/**
 * Fallback merge for servers whose document symbols carry no instance
 * children: surfaces bare instance NAMES collected from workspace-symbol
 * container scopes.  Only applied when no typed instance exists; names are
 * never turned into guessed types.
 */
export function applyInstanceNameFallback(
    instances: InstanceRecord[],
    fallbackNames?: string[],
): InstanceRecord[] {
    if (instances.length > 0 || !fallbackNames || fallbackNames.length === 0) {
        return instances;
    }
    return fallbackNames.map((name) => ({ instanceName: name }));
}

/**
 * Builds the "Instantiate Module" quick-pick items from raw workspace-module
 * references: exact (name, uri) repeats are deduped, entries sort by module
 * name then uri (deterministic regardless of provider order), label carries
 * the module name, detail always shows the display path so same-named modules
 * in different files stay distinguishable - and when a name is defined in
 * more than one file the path is ALSO repeated in description to make the
 * duplicates visually obvious.
 */
export function buildModuleQuickPickItems(
    modules: readonly (WorkspaceModuleRef | undefined)[],
    toDisplayPath: (uri: string) => string,
): ModuleQuickPickItem[] {
    const uniqueByNameAndUri = new Map<string, WorkspaceModuleRef>();
    for (const module of modules ?? []) {
        if (!module || !module.name || !module.uri) {
            continue;
        }
        uniqueByNameAndUri.set(`${module.name}|${module.uri}`, { name: module.name, uri: module.uri });
    }
    const sorted = [...uniqueByNameAndUri.values()].sort(
        (a, b) => compareStrings(a.name, b.name) || compareStrings(a.uri, b.uri),
    );

    const definitionsPerName = new Map<string, number>();
    for (const module of sorted) {
        definitionsPerName.set(module.name, (definitionsPerName.get(module.name) ?? 0) + 1);
    }

    return sorted.map((module) => {
        const displayPath = toDisplayPath(module.uri);
        const isDuplicate = (definitionsPerName.get(module.name) ?? 0) > 1;
        return {
            name: module.name,
            uri: module.uri,
            label: module.name,
            detail: displayPath,
            ...(isDuplicate ? { description: displayPath } : {}),
        };
    });
}

function compareStrings(a: string, b: string): number {
    // Plain code-unit comparison keeps the order deterministic across locales.
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareByName(a: { name: string }, b: { name: string }): number {
    // Plain code-unit comparison keeps the order deterministic across locales.
    return compareStrings(a.name, b.name);
}

/** Stable label for the legacy-only root that keeps unreachable cycles visible. */
export const UNREACHABLE_CYCLE_GROUP_NAME = '(unreachable cycles)';

type ModuleGraph = Map<string, string[]>;

function moduleGraph(byName: Map<string, ModuleRecord>): ModuleGraph {
    const graph: ModuleGraph = new Map();
    for (const name of [...byName.keys()].sort(compareStrings)) {
        const record = byName.get(name)!;
        const targets = new Set<string>();
        for (const instance of record.instances ?? []) {
            if (instance.moduleType !== undefined && byName.has(instance.moduleType)) {
                targets.add(instance.moduleType);
            }
        }
        graph.set(name, [...targets].sort(compareStrings));
    }
    return graph;
}

/**
 * Kosaraju's SCC walk, written iteratively so a long legacy module chain does
 * not consume the JavaScript call stack. Neighbors and component members are
 * sorted to make the selected cycle representatives independent of provider
 * discovery order.
 */
function stronglyConnectedComponents(graph: ModuleGraph): string[][] {
    const names = [...graph.keys()].sort(compareStrings);
    const visited = new Set<string>();
    const finishOrder: string[] = [];

    for (const start of names) {
        if (visited.has(start)) {
            continue;
        }
        visited.add(start);
        const stack: Array<{ name: string; nextNeighborIndex: number }> = [{
            name: start,
            nextNeighborIndex: 0,
        }];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const neighbors = graph.get(frame.name) ?? [];
            if (frame.nextNeighborIndex < neighbors.length) {
                const neighbor = neighbors[frame.nextNeighborIndex];
                frame.nextNeighborIndex += 1;
                if (!visited.has(neighbor)) {
                    visited.add(neighbor);
                    stack.push({ name: neighbor, nextNeighborIndex: 0 });
                }
            } else {
                finishOrder.push(frame.name);
                stack.pop();
            }
        }
    }

    const reverse = new Map<string, string[]>();
    for (const name of names) {
        reverse.set(name, []);
    }
    for (const [source, targets] of graph) {
        for (const target of targets) {
            reverse.get(target)!.push(source);
        }
    }
    for (const neighbors of reverse.values()) {
        neighbors.sort(compareStrings);
    }

    const assigned = new Set<string>();
    const components: string[][] = [];
    for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
        const start = finishOrder[index];
        if (assigned.has(start)) {
            continue;
        }
        const component: string[] = [];
        const stack = [start];
        assigned.add(start);
        while (stack.length > 0) {
            const name = stack.pop()!;
            component.push(name);
            const neighbors = reverse.get(name) ?? [];
            for (let neighborIndex = neighbors.length - 1; neighborIndex >= 0; neighborIndex -= 1) {
                const neighbor = neighbors[neighborIndex];
                if (!assigned.has(neighbor)) {
                    assigned.add(neighbor);
                    stack.push(neighbor);
                }
            }
        }
        component.sort(compareStrings);
        components.push(component);
    }
    return components.sort((a, b) => compareStrings(a[0], b[0]));
}

function reachableModuleNames(roots: readonly ModuleRecord[], graph: ModuleGraph): Set<string> {
    const reachable = new Set<string>();
    const pending = roots.map((root) => root.name).sort(compareStrings).reverse();
    while (pending.length > 0) {
        const name = pending.pop()!;
        if (reachable.has(name)) {
            continue;
        }
        reachable.add(name);
        const neighbors = graph.get(name) ?? [];
        for (let index = neighbors.length - 1; index >= 0; index -= 1) {
            if (!reachable.has(neighbors[index])) {
                pending.push(neighbors[index]);
            }
        }
    }
    return reachable;
}

/**
 * Returns source SCCs in the part of the module graph unreachable from every
 * ordinary zero-incoming root. A source SCC is enough to expose all of its
 * downstream definitions; omitting downstream SCCs avoids duplicate cycle
 * entries in the synthetic group.
 */
function unreachableCycleComponents(
    byName: Map<string, ModuleRecord>,
    roots: readonly ModuleRecord[],
): string[][] {
    const graph = moduleGraph(byName);
    const reachable = reachableModuleNames(roots, graph);
    const components = stronglyConnectedComponents(graph);
    const componentForName = new Map<string, number>();
    components.forEach((component, index) => {
        for (const name of component) {
            componentForName.set(name, index);
        }
    });

    const unreachableComponentIndexes = new Set<number>();
    for (const [name, componentIndex] of componentForName) {
        if (!reachable.has(name)) {
            unreachableComponentIndexes.add(componentIndex);
        }
    }

    const hasUnreachableIncoming = new Set<number>();
    for (const [source, targets] of graph) {
        const sourceIndex = componentForName.get(source)!;
        if (!unreachableComponentIndexes.has(sourceIndex)) {
            continue;
        }
        for (const target of targets) {
            const targetIndex = componentForName.get(target)!;
            if (targetIndex !== sourceIndex && unreachableComponentIndexes.has(targetIndex)) {
                hasUnreachableIncoming.add(targetIndex);
            }
        }
    }

    return components.filter((component, componentIndex) => {
        if (component.some((name) => reachable.has(name)) ||
            !unreachableComponentIndexes.has(componentIndex) ||
            hasUnreachableIncoming.has(componentIndex)) {
            return false;
        }
        return component.length > 1 || (graph.get(component[0]) ?? []).includes(component[0]);
    });
}

/**
 * Builds the instantiation-hierarchy forest: one root per top-level module
 * (a module never instantiated by any other DISCOVERED module), sorted by
 * name. Each root expands into its instances with an explicit depth-first
 * stack; expansion follows declaration order and clones the ancestor path per
 * branch, so diamond instantiations re-expand while cycles are broken
 * deterministically (the repeated module becomes a leaf flagged
 * isCycleTruncated). A response-wide node budget (MAX_EXPANDED_NODES) bounds
 * diamond-heavy blowup the same way: once spent, deeper modules become leaves
 * flagged isBudgetTruncated.
 *
 * Definitions in a closed SCC have no zero-incoming root. The legacy path
 * keeps those definitions visible under one deterministic synthetic
 * `(unreachable cycles)` root, while retaining the same branch-local cycle
 * truncation used for reachable cycles.
 *
 * Instances whose type is missing OR names no discovered module never produce
 * edges: type-less instances are grouped under a synthetic "(unresolved)"
 * node, instances with a known type text but no discovered definition stay as
 * non-expandable leaves carrying their type.
 */
export function buildHierarchy(
    modules: ModuleRecord[],
    outputBudget?: HierarchyBuildBudget,
): HierarchyRoot[] {
    const byName = new Map<string, ModuleRecord>();
    for (const module of modules ?? []) {
        if (module && module.name && !byName.has(module.name)) {
            byName.set(module.name, module);
        }
    }

    const instantiatedTypes = new Set<string>();
    for (const module of byName.values()) {
        for (const instance of module.instances ?? []) {
            if (instance.moduleType !== undefined && byName.has(instance.moduleType)) {
                instantiatedTypes.add(instance.moduleType);
            }
        }
    }

    // A definition reached from another discovered definition is never an
    // ordinary root. In particular, do not promote an arbitrary member of a
    // closed cycle: doing so makes an instantiated definition appear to be a
    // top-level design.
    const tops = [...byName.values()]
        .filter((module) => !instantiatedTypes.has(module.name))
        .sort(compareByName);
    const budget = newExpansionBudget(outputBudget);
    const cycleComponents = unreachableCycleComponents(byName, tops);
    const cycleGroup = cycleComponents.length > 0
        ? buildUnreachableCycleGroup(cycleComponents, byName, budget)
        : undefined;

    const roots: HierarchyRoot[] = [];
    for (const top of tops) {
        if (outputBudget !== undefined && !outputBudget.takeRootSlot()) {
            noteBuildTruncation(budget);
            break;
        }
        const copiedContents = contentsForBuild(top, budget, outputBudget);
        if (copiedContents.truncated) {
            budget.truncated = true;
            budget.markerAttached = true;
            outputBudget?.markTruncationAttached();
        }
        roots.push({
            ...(top.id ? { id: top.id } : {}),
            name: top.name,
            uri: top.uri,
            range: top.range,
            ...copiedContents.contents,
            ...(copiedContents.truncated ? { isBudgetTruncated: true } : {}),
            children: expandInstances(top, byName, new Set([top.name]), budget),
        });
    }
    if (cycleGroup !== undefined) {
        if (outputBudget === undefined || outputBudget.takeRootSlot()) {
            roots.push(cycleGroup);
        } else {
            noteBuildTruncation(budget);
        }
    }
    if (budget.truncated && !budget.markerAttached && roots.length > 0) {
        roots[roots.length - 1].isBudgetTruncated = true;
        budget.markerAttached = true;
        outputBudget?.markTruncationAttached();
    }
    return roots;
}

function buildUnreachableCycleGroup(
    components: readonly string[][],
    byName: Map<string, ModuleRecord>,
    budget: ExpansionBudget,
): HierarchyRoot {
    const children: HierarchyNode[] = [];
    for (const component of components) {
        const representative = byName.get(component[0]);
        if (representative === undefined) {
            continue;
        }

        // The representative is a synthetic navigation entry, not a new
        // definition. Its expansion starts with the representative on the
        // active path, so the first repeated edge is still cycle-truncated.
        const representativeInstance: InstanceRecord = {
            instanceName: representative.name,
            moduleType: representative.name,
            ...(representative.id ? { definitionId: representative.id } : {}),
        };
        if (takeExpansionSlot(budget)) {
            const node = knownInstanceNode(
                representativeInstance,
                representative,
                { uri: representative.uri, range: representative.range },
                'ordinary',
                budget,
            );
            children.push(node);
            if (representative.instances.length > 0) {
                node.children = expandInstances(
                    representative,
                    byName,
                    new Set([representative.name]),
                    budget,
                );
            }
        } else if (takeTerminalSlot(budget)) {
            // Preserve a visible, bounded component marker even when another
            // root has consumed the ordinary expansion slots.
            children.push(knownInstanceNode(
                representativeInstance,
                representative,
                { uri: representative.uri, range: representative.range },
                'budget',
                budget,
            ));
        } else {
            break;
        }
    }

    return {
        id: 'synthetic:unreachable-cycles',
        name: UNREACHABLE_CYCLE_GROUP_NAME,
        isSyntheticGroup: true,
        children,
    };
}

function contentsFromRecord(record: ModuleRecord): HierarchyContents {
    const hasContents = record.ports !== undefined || record.params !== undefined || record.signals !== undefined;
    return {
        ...(record.ports !== undefined ? { ports: record.ports } : {}),
        ...(record.params !== undefined ? { params: record.params } : {}),
        ...(record.signals !== undefined ? { signals: record.signals } : {}),
        ...(hasContents || record.contentSource !== undefined
            ? { contentSource: record.contentSource ?? 'declaration' }
            : {}),
        ...(record.isAmbiguousDefinition ? { isAmbiguousDefinition: true } : {}),
    };
}

interface BuiltHierarchyContents {
    contents: HierarchyContents;
    truncated: boolean;
}

function contentsForBuild(
    record: ModuleRecord,
    expansionBudget?: ExpansionBudget,
    outputBudget?: HierarchyBuildBudget,
): BuiltHierarchyContents {
    if (expansionBudget === undefined) {
        return { contents: contentsFromRecord(record), truncated: false };
    }

    const copyGroup = (children: ClassifiedChild[] | undefined): ClassifiedChild[] | undefined => {
        if (children === undefined) {
            return undefined;
        }
        const copied: ClassifiedChild[] = [];
        for (const child of children) {
            if (!takeHierarchyContentSlot(expansionBudget, outputBudget)) {
                return copied.length > 0 ? copied : undefined;
            }
            copied.push(child);
        }
        return copied;
    };

    let truncated = false;
    const ports = copyGroup(record.ports);
    truncated = truncated || record.ports !== undefined && ports?.length !== record.ports.length;
    const params = copyGroup(record.params);
    truncated = truncated || record.params !== undefined && params?.length !== record.params.length;
    const signals = copyGroup(record.signals);
    truncated = truncated || record.signals !== undefined && signals?.length !== record.signals.length;
    const hasContents = record.ports !== undefined || record.params !== undefined || record.signals !== undefined;
    return {
        contents: {
            ...(ports !== undefined ? { ports } : {}),
            ...(params !== undefined ? { params } : {}),
            ...(signals !== undefined ? { signals } : {}),
            ...(hasContents || record.contentSource !== undefined
                ? { contentSource: record.contentSource ?? 'declaration' }
                : {}),
            ...(record.isAmbiguousDefinition ? { isAmbiguousDefinition: true } : {}),
        },
        truncated,
    };
}

interface ExpansionFrame {
    module: ModuleRecord;
    path: Set<string>;
    nextInstanceIndex: number;
    output: HierarchyNode[];
    unresolved: HierarchyNode[];
    unresolvedGroupReserved: boolean;
    unresolvedBudgetTruncated: boolean;
}

interface ExpansionBudget {
    /** Remaining emitted descendant-node slots for the complete response. */
    remaining: number;
    /** Terminal slots reserved for a cycle and one budget marker. */
    terminalSlots: number;
    /** Only one client-side budget marker may be emitted for the response. */
    budgetMarkerEmitted: boolean;
    /** Shared client snapshot budget, present only on the legacy path. */
    shared?: HierarchyBuildBudget;
    /** Shared or expansion-local output was truncated. */
    truncated: boolean;
    /** A visible marker has already been attached to a root or node. */
    markerAttached: boolean;
}

const EXPANSION_TERMINAL_SLOTS = 2;

function newExpansionBudget(shared?: HierarchyBuildBudget): ExpansionBudget {
    return {
        remaining: MAX_EXPANDED_NODES,
        terminalSlots: Math.min(EXPANSION_TERMINAL_SLOTS, MAX_EXPANDED_NODES),
        budgetMarkerEmitted: false,
        shared,
        truncated: false,
        markerAttached: false,
    };
}

function noteBuildTruncation(budget: ExpansionBudget): void {
    budget.truncated = true;
    if (budget.shared !== undefined) {
        budget.shared.noteTruncation();
    } else if (!budget.budgetMarkerEmitted) {
        // Content is part of the same expansion response. Keep one terminal
        // slot for its deterministic truncation marker even though the
        // marker is attached to the retained root/node rather than emitted as
        // a separate child here.
        if (budget.remaining > 0) {
            budget.remaining -= 1;
        }
        budget.budgetMarkerEmitted = true;
    }
}

function takeHierarchyContentSlot(
    expansionBudget: ExpansionBudget,
    outputBudget?: HierarchyBuildBudget,
): boolean {
    const sharedBudget = outputBudget ?? expansionBudget.shared;
    if (sharedBudget !== undefined) {
        const took = sharedBudget.takeContentSlot();
        if (!took) {
            noteBuildTruncation(expansionBudget);
        }
        return took;
    }
    // Keep one terminal slot for the marker attached to the root/node that
    // retained the prefix. This makes direct buildHierarchy callers obey the
    // same content bound as the client-backed path.
    if (expansionBudget.remaining <= 1) {
        noteBuildTruncation(expansionBudget);
        return false;
    }
    expansionBudget.remaining -= 1;
    return true;
}

function takeExpansionSlot(budget: ExpansionBudget): boolean {
    if (budget.shared !== undefined) {
        const took = budget.shared.takeNodeSlot();
        if (!took) {
            noteBuildTruncation(budget);
        }
        return took;
    }
    // Keep a cycle terminal and one clear budget terminal available while
    // ordinary nodes are being expanded. This is what lets a cycle remain a
    // cycle at the response boundary without allowing a second budget marker.
    if (budget.remaining <= budget.terminalSlots) {
        return false;
    }
    budget.remaining -= 1;
    return true;
}

function takeTerminalSlot(budget: ExpansionBudget): boolean {
    if (budget.shared !== undefined) {
        const took = budget.shared.takeNodeSlot();
        if (!took) {
            noteBuildTruncation(budget);
        }
        return took;
    }
    if (budget.remaining <= 0) {
        return false;
    }
    budget.remaining -= 1;
    if (budget.terminalSlots > 0) {
        budget.terminalSlots -= 1;
    }
    return true;
}

function takeCycleSlot(budget: ExpansionBudget): boolean {
    if (budget.shared !== undefined) {
        return takeExpansionSlot(budget);
    }
    if (budget.remaining <= 0) {
        return false;
    }
    if (budget.terminalSlots > 0) {
        return takeTerminalSlot(budget);
    }
    return takeExpansionSlot(budget);
}

function takeBudgetMarkerSlot(budget: ExpansionBudget): boolean {
    if (budget.shared !== undefined) {
        noteBuildTruncation(budget);
        return false;
    }
    if (budget.budgetMarkerEmitted || budget.remaining <= 0) {
        return false;
    }
    if (budget.remaining <= budget.terminalSlots) {
        takeTerminalSlot(budget);
    } else {
        budget.remaining -= 1;
    }
    budget.budgetMarkerEmitted = true;
    return true;
}

function hasPendingInstances(stack: readonly ExpansionFrame[]): boolean {
    return stack.some((frame) => frame.nextInstanceIndex < frame.module.instances.length);
}

function finishExpansionFrame(frame: ExpansionFrame): void {
    if ((frame.unresolved.length > 0 && frame.unresolvedGroupReserved) ||
        frame.unresolvedBudgetTruncated) {
        frame.output.push({
            isUnresolvedGroup: true,
            ...(frame.unresolvedBudgetTruncated ? { isBudgetTruncated: true } : {}),
            children: frame.unresolved,
        });
    }
}

function locationForInstance(
    instance: InstanceRecord,
    target: ModuleRecord,
): Pick<HierarchyNode, 'uri' | 'range'> {
    return instance.uri !== undefined || instance.range !== undefined
        ? {
            ...(instance.uri !== undefined ? { uri: instance.uri } : {}),
            ...(instance.range !== undefined ? { range: instance.range } : {}),
        }
        : { uri: target.uri, range: target.range };
}

type NodeTruncation = 'ordinary' | 'cycle' | 'budget' | 'cycle-budget';

function knownInstanceNode(
    instance: InstanceRecord,
    target: ModuleRecord,
    location: Pick<HierarchyNode, 'uri' | 'range'>,
    truncation: NodeTruncation,
    budget?: ExpansionBudget,
): HierarchyNode {
    const copiedContents = contentsForBuild(target, budget);
    if (copiedContents.truncated && budget !== undefined) {
        budget.truncated = true;
        budget.markerAttached = true;
        budget.shared?.markTruncationAttached();
    }
    return {
        instanceName: instance.instanceName,
        moduleType: target.name,
        ...(instance.definitionId ?? target.id
            ? { definitionId: instance.definitionId ?? target.id }
            : {}),
        ...location,
        ...copiedContents.contents,
        ...(copiedContents.truncated ? { isBudgetTruncated: true } : {}),
        ...(truncation === 'ordinary' ? { isCycleTruncated: undefined } : {}),
        ...(truncation === 'cycle' || truncation === 'cycle-budget'
            ? { isCycleTruncated: true }
            : {}),
        ...(truncation === 'budget' || truncation === 'cycle-budget'
            ? { isBudgetTruncated: true }
            : {}),
        children: [],
    };
}

function unknownInstanceNode(
    instance: InstanceRecord,
    moduleType: string,
    isBudgetTruncated = false,
): HierarchyNode {
    return {
        instanceName: instance.instanceName,
        moduleType,
        ...(instance.uri ? { uri: instance.uri } : {}),
        ...(instance.range ? { range: instance.range } : {}),
        ...(isBudgetTruncated ? { isBudgetTruncated: true } : {}),
        children: [],
    };
}

/**
 * Emits one boundary node for the shallowest still-unvisited branch. Picking
 * the shallowest frame keeps the marker in the same declaration-order branch
 * that the user would visit next, instead of burying it below an arbitrary
 * active path. A cycle gets its own reserved terminal first; the omitted
 * current occurrence can then use the single budget marker.
 */
function emitBoundaryMarker(
    stack: ExpansionFrame[],
    byName: Map<string, ModuleRecord>,
    budget: ExpansionBudget,
    currentFrame: ExpansionFrame,
    currentInstance: InstanceRecord,
): boolean {
    const pendingFrame = stack.find((frame) =>
        frame.nextInstanceIndex < frame.module.instances.length,
    );
    if (pendingFrame && pendingFrame !== currentFrame) {
        const pending = pendingFrame.module.instances[pendingFrame.nextInstanceIndex];
        pendingFrame.nextInstanceIndex += 1;
        const target = pending.moduleType !== undefined ? byName.get(pending.moduleType) : undefined;
        if (target !== undefined && pendingFrame.path.has(target.name)) {
            if (takeCycleSlotForNode(pendingFrame, pending, target, budget)) {
                // The current occurrence was before this cycle in wire order;
                // retain it as the one budget marker when it was omitted.
                return appendBudgetMarker(currentFrame, currentInstance, byName, budget);
            }
        } else if (target === undefined && pending.moduleType === undefined) {
            return appendUnresolvedBudgetMarker(pendingFrame, budget);
        } else {
            return appendBudgetMarker(pendingFrame, pending, byName, budget);
        }
    }
    return appendBudgetMarker(currentFrame, currentInstance, byName, budget);
}

function takeCycleSlotForNode(
    frame: ExpansionFrame,
    instance: InstanceRecord,
    target: ModuleRecord,
    budget: ExpansionBudget,
): boolean {
    if (!takeCycleSlot(budget)) {
        return false;
    }
    frame.output.push(knownInstanceNode(
        instance,
        target,
        locationForInstance(instance, target),
        'cycle',
        budget,
    ));
    return true;
}

function appendBudgetMarker(
    frame: ExpansionFrame,
    instance: InstanceRecord,
    byName: Map<string, ModuleRecord>,
    budget: ExpansionBudget,
): boolean {
    const target = instance.moduleType !== undefined ? byName.get(instance.moduleType) : undefined;
    if (!takeBudgetMarkerSlot(budget)) {
        return false;
    }
    if (target !== undefined) {
        frame.output.push(knownInstanceNode(
            instance,
            target,
            locationForInstance(instance, target),
            'budget',
            budget,
        ));
    } else if (instance.moduleType !== undefined) {
        frame.output.push(unknownInstanceNode(instance, instance.moduleType, true));
    } else {
        frame.unresolvedBudgetTruncated = true;
    }
    return true;
}

function appendUnresolvedBudgetMarker(frame: ExpansionFrame, budget: ExpansionBudget): boolean {
    if (!takeBudgetMarkerSlot(budget)) {
        return false;
    }
    frame.unresolvedBudgetTruncated = true;
    return true;
}

function drainExpansionStack(stack: ExpansionFrame[]): void {
    while (stack.length > 0) {
        finishExpansionFrame(stack[stack.length - 1]);
        stack.pop();
    }
}

function expandInstances(
    module: ModuleRecord,
    byName: Map<string, ModuleRecord>,
    path: Set<string>,
    budget: ExpansionBudget,
): HierarchyNode[] {
    const result: HierarchyNode[] = [];
    const stack: ExpansionFrame[] = [{
        module,
        path,
        nextInstanceIndex: 0,
        output: result,
        unresolved: [],
        unresolvedGroupReserved: false,
        unresolvedBudgetTruncated: false,
    }];

    // This is the explicit equivalent of the old recursive depth-first walk.
    // A frame owns the output array for one module occurrence and its path set;
    // pushing a child frame therefore preserves both branch-local cycle
    // detection and declaration order without consuming the JS call stack.
    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (budget.remaining <= 0) {
            drainExpansionStack(stack);
            break;
        }
        if (frame.nextInstanceIndex >= frame.module.instances.length) {
            finishExpansionFrame(frame);
            stack.pop();
            continue;
        }

        const instance = frame.module.instances[frame.nextInstanceIndex];
        frame.nextInstanceIndex += 1;
        const target = instance.moduleType !== undefined
            ? byName.get(instance.moduleType)
            : undefined;

        if (target === undefined) {
            if (instance.moduleType === undefined) {
                // The group itself is an output node. Reserve it together
                // with its first child so an exhausted budget never creates
                // an inaccessible child without its group wrapper.
                if (!frame.unresolvedGroupReserved && budget.remaining > budget.terminalSlots + 1 &&
                    takeExpansionSlot(budget)) {
                    frame.unresolvedGroupReserved = true;
                }
                if (frame.unresolvedGroupReserved && takeExpansionSlot(budget)) {
                    frame.unresolved.push({
                        instanceName: instance.instanceName,
                        ...(instance.uri ? { uri: instance.uri } : {}),
                        ...(instance.range ? { range: instance.range } : {}),
                        children: [],
                    });
                } else if (appendUnresolvedBudgetMarker(frame, budget)) {
                    drainExpansionStack(stack);
                    break;
                } else {
                    drainExpansionStack(stack);
                    break;
                }
            } else if (takeExpansionSlot(budget)) {
                frame.output.push(unknownInstanceNode(instance, instance.moduleType));
            } else if (hasPendingInstances(stack)) {
                const emitted = emitBoundaryMarker(stack, byName, budget, frame, instance);
                drainExpansionStack(stack);
                if (!emitted) {
                    break;
                }
                break;
            } else if (takeTerminalSlot(budget)) {
                frame.output.push(unknownInstanceNode(instance, instance.moduleType));
            } else {
                drainExpansionStack(stack);
                break;
            }
            continue;
        }

        // An instantiation site is the useful navigation target. The module
        // definition is only a compatibility fallback when the instance did
        // not carry any location at all. Keeping the pair together avoids
        // combining a raw URI from one file with a definition range from
        // another file when a legacy payload is only partially populated.
        const location = locationForInstance(instance, target);
        const cyclic = frame.path.has(target.name);
        if (cyclic) {
            // Cycle checks intentionally happen before budget checks, as they
            // did in the recursive implementation. A cycle is represented by
            // a flagged terminal whenever a slot remains.
            if (takeCycleSlot(budget)) {
                frame.output.push(knownInstanceNode(instance, target, location, 'cycle', budget));
            } else if (takeBudgetMarkerSlot(budget)) {
                frame.output.push(knownInstanceNode(instance, target, location, 'cycle-budget', budget));
                drainExpansionStack(stack);
                break;
            } else {
                drainExpansionStack(stack);
                break;
            }
            continue;
        }

        const targetHasChildren = target.instances.length > 0;
        if (!takeExpansionSlot(budget)) {
            const hasContinuation = targetHasChildren || hasPendingInstances(stack);
            if (hasContinuation) {
                const emitted = emitBoundaryMarker(stack, byName, budget, frame, instance);
                drainExpansionStack(stack);
                if (!emitted) {
                    break;
                }
                break;
            }
            if (!takeTerminalSlot(budget)) {
                drainExpansionStack(stack);
                break;
            }
        }
        const node = knownInstanceNode(instance, target, location, 'ordinary', budget);
        frame.output.push(node);
        if (targetHasChildren) {
            const childPath = new Set(frame.path);
            childPath.add(target.name);
            stack.push({
                module: target,
                path: childPath,
                nextInstanceIndex: 0,
                output: node.children,
                unresolved: [],
                unresolvedGroupReserved: false,
                unresolvedBudgetTruncated: false,
            });
        }
    }

    return result;
}
