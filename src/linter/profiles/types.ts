/** Tool profiles contain all tool-specific flags and output knowledge, without VS Code imports. */
/** Llg always compiles SystemVerilog IEEE 1800-2009; external linters follow it. */
export const LANGUAGE_STANDARD = '1800-2009';
export type LintSeverity = 'error' | 'warning' | 'information' | 'hint';
export interface LinterContext {
  file: string;
  languageId: string;
  includeDirectories: string[];
  get<T>(key: string, fallback: T): T;
}
export interface DiagnosticPattern {
  /** Named groups: file, line, message; optional column, severity, code. Positions are one-based. */
  regex: RegExp;
  defaultSeverity?: LintSeverity;
}
export interface LinterProfile {
  id: string;
  label: string;
  executable: string;
  windowsExecutable?: string;
  legacySection?: string;
  configuration?: Record<string, Record<string, unknown>>;
  output: 'stdout' | 'stderr' | 'both';
  /** Static flags shown as the `arguments` setting default; a user value replaces them. */
  defaultArguments: string[];
  /** Context-dependent flags only (include directories, language mode, work library). */
  arguments(context: LinterContext): string[];
  diagnostics: DiagnosticPattern[];
  severities: Readonly<Record<string, LintSeverity>>;
}
export interface ParsedDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  code?: string;
  severity: LintSeverity;
}

export function parseDiagnostics(profile: LinterProfile, output: string): ParsedDiagnostic[] {
  const diagnostics: ParsedDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    for (const pattern of profile.diagnostics) {
      pattern.regex.lastIndex = 0;
      const groups = pattern.regex.exec(line)?.groups;
      if (!groups) { continue; }
      const lineNumber = Number(groups.line);
      const column = groups.column === undefined ? 1 : Number(groups.column);
      if (!groups.file || !Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(column) || column < 1) {
        break;
      }
      diagnostics.push({
        file: groups.file.trim(), line: lineNumber - 1, column: column - 1,
        message: groups.message.trim(), code: groups.code,
        severity: profile.severities[groups.severity?.toLowerCase()] ?? pattern.defaultSeverity ?? 'information',
      });
      break;
    }
  }
  return diagnostics;
}
