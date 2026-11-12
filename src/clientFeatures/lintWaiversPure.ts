// SPDX-License-Identifier: MIT

export const LINT_WAIVER_PREFIX = 'hdlsupport-lint-waive';
const EXTERNAL_LINTER_SOURCES = new Set(['xvlog', 'slang', 'modelsim', 'verilator']);

export interface WaivableDiagnostic {
    source?: string;
    code?: unknown;
    range: { start: { line: number } };
}

function codeValue(code: unknown): string | undefined {
    if (typeof code === 'string' || typeof code === 'number') {
        return String(code);
    }
    if (typeof code === 'object' && code !== null && 'value' in code) {
        const value = (code as { value?: unknown }).value;
        return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
    }
    return undefined;
}

export function diagnosticWaiverId(diagnostic: Pick<WaivableDiagnostic, 'source' | 'code'>): string | undefined {
    const source = diagnostic.source?.trim().toLowerCase();
    const code = codeValue(diagnostic.code)?.trim().toLowerCase();
    return source && code ? `${source}:${code}` : undefined;
}

export function isExternalLinterSource(source: string | undefined): boolean {
    return EXTERNAL_LINTER_SOURCES.has(source?.trim().toLowerCase() ?? '');
}

export function verilatorDocumentationUrl(diagnostic: Pick<WaivableDiagnostic, 'source' | 'code'>): string | undefined {
    if (diagnostic.source?.trim().toLowerCase() !== 'verilator') {
        return undefined;
    }
    const id = diagnosticWaiverId(diagnostic);
    if (!id) {
        return undefined;
    }
    const code = id.slice(id.indexOf(':') + 1).toUpperCase();
    return `https://verilator.org/guide/latest/warnings.html#cmdoption-Wno-${code}`;
}

export function lineWaivesDiagnostic(line: string, waiverId: string): boolean {
    const markers = line.matchAll(new RegExp(`(?:^|\\s)//\\s*${LINT_WAIVER_PREFIX}\\s+([^\\s]+)`, 'gi'));
    return [...markers].some((marker) => marker[1].toLowerCase() === waiverId.toLowerCase());
}

export function isDiagnosticWaived(
    diagnostic: WaivableDiagnostic,
    configuredWaivers: readonly string[],
    lines: readonly string[],
): boolean {
    const id = diagnosticWaiverId(diagnostic);
    if (!id) {
        return false;
    }
    if (configuredWaivers.some((waiver) => waiver.trim().toLowerCase() === id)) {
        return true;
    }
    const line = diagnostic.range.start.line;
    return lineWaivesDiagnostic(lines[line] ?? '', id) || (line > 0 && lineWaivesDiagnostic(lines[line - 1] ?? '', id));
}
