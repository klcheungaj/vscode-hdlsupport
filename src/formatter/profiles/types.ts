/**
 * Formatter profiles contain all tool-specific flags, without VS Code imports.
 * A formatter reads the document on stdin and writes the formatted document to stdout.
 */
export interface FormatterContext {
  languageId: string;
  get<T>(key: string, fallback: T): T;
}

export interface FormatterProfile {
  id: string;
  label: string;
  executable: string;
  windowsExecutable?: string;
  /** Language IDs the tool formats. */
  languages: readonly string[];
  /** Extra per-tool settings contributed under `hdlsupport.verilog.formatting.<id>`. */
  configuration?: Record<string, Record<string, unknown>>;
  /** Static flags shown as the `arguments` setting default; a user value replaces them. */
  defaultArguments: string[];
  /** Context-dependent flags, including the one that makes the tool read stdin. */
  arguments(context: FormatterContext): string[];
  /**
   * Flags that restrict formatting to one-based, inclusive lines while the tool
   * still outputs the whole document. Omit when the tool formats whole files only.
   */
  rangeArguments?(startLine: number, endLine: number): string[];
}
