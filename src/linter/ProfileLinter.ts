import * as vscode from 'vscode';
import type * as child from 'child_process';
import * as path from 'path';
import { readFileSync } from 'fs';
import { Logger } from '../logger';
import { executeFile, resolveExecutable, terminateProcess } from './processExecution';
import { LinterProfile, LintSeverity, parseDiagnostics } from './profiles/types';
import { splitArguments } from './arguments';
import { linterIncludeDirectories } from './includeDirectories';
import { closestConfigPath, isFileSync } from '../languageServer/llgConfigDiscovery';
import { effectiveConfigPath } from '../languageServer/initOptions';

const SEVERITIES: Record<LintSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information, hint: vscode.DiagnosticSeverity.Hint,
};

export interface LintDiagnosticSet {
  uri: vscode.Uri;
  diagnostics: vscode.Diagnostic[];
}

export interface LintResult {
  diagnostics: LintDiagnosticSet[];
  clearExisting: boolean;
  /** Replace only diagnostics owned by the document that initiated this lint request. */
  replaceOwned?: boolean;
}

/** What `LintManager` needs from a linter. */
export interface Linter {
  readonly name: string;
  startLint(document: vscode.TextDocument): Promise<LintResult>;
  dispose(): void;
}

interface CommandResult {
  error: child.ExecFileException | null;
  stdout: string;
  stderr: string;
}

/** Shared settings, process lifecycle, path handling and diagnostic publication for every profile. */
export default class ProfileLinter implements Linter {
  readonly name: string;
  private readonly processes = new Map<child.ChildProcess, () => void>();
  private disposed = false;

  constructor(private readonly profile: LinterProfile, private readonly logger: Logger) {
    this.name = profile.id;
  }

  /** The document's directory plus the directories of the `llg.toml` that governs it. */
  private includeDirectories(document: vscode.TextDocument, workspaceRoot: string | undefined): string[] {
    const documentDirectory = path.dirname(document.fileName);
    const rootConfigPath = workspaceRoot === undefined ? undefined : effectiveConfigPath(
      workspaceRoot, vscode.workspace.getConfiguration('hdlsupport.llg', document.uri).get<string>('configPath', ''));
    const configPath = closestConfigPath(document.fileName, workspaceRoot, rootConfigPath, isFileSync);
    let configText: string | undefined;
    if (configPath !== undefined) {
      try { configText = readFileSync(configPath, 'utf8'); } catch { configText = undefined; }
    }
    return linterIncludeDirectories({
      documentDirectory, fallbackDirectory: workspaceRoot ?? documentDirectory, configPath, configText,
    });
  }

  async startLint(document: vscode.TextDocument): Promise<LintResult> {
    if (this.disposed) { return { diagnostics: [], clearExisting: false }; }
    const settings = vscode.workspace.getConfiguration(`hdlsupport.verilog.linting.${this.name}`, document.uri);
    const legacy = this.profile.legacySection
      ? vscode.workspace.getConfiguration(this.profile.legacySection, document.uri) : undefined;
    const get = <T>(key: string, fallback: T): T => {
      // Registered defaults must not hide explicitly configured legacy xvlog settings.
      const inspected = settings.inspect<T>(key);
      const explicit = inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
      return explicit ?? legacy?.get<T>(key) ?? settings.get<T>(key, fallback);
    };
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    const workspace = workspaceRoot ?? path.dirname(document.fileName);
    const runAtFileLocation = vscode.workspace.getConfiguration('hdlsupport.verilog.linting', document.uri)
      .get<boolean>('runAtFileLocation', false);
    const cwd = runAtFileLocation ? path.dirname(document.fileName) : workspace;
    let directories = this.includeDirectories(document, workspaceRoot);
    const useWsl = process.platform === 'win32' && get('useWSL', false);
    let file = document.fileName;
    let serverCwd = cwd;
    const translate = async (value: string, windows = false): Promise<string> => {
      const result = await this.execute('wsl', { cwd, timeout: 10_000 }, ['--exec', 'wslpath', windows ? '-w' : '-u', value]);
      if (result.error) { throw result.error; }
      return result.stdout.trim();
    };
    if (useWsl) {
      file = await translate(file);
      serverCwd = await translate(cwd);
      directories = await Promise.all(directories.map(directory => translate(directory)));
    }
    const defaultExecutable = process.platform === 'win32' && !useWsl
      ? this.profile.windowsExecutable ?? `${this.profile.executable}.exe` : this.profile.executable;
    // Accept existing legacy directory settings as well as documented executable paths.
    let executable = await resolveExecutable(get('path', ''), defaultExecutable);
    if (useWsl && path.win32.isAbsolute(executable)) { executable = await translate(executable); }
    let args = [
      ...this.profile.arguments({ file, languageId: document.languageId, includeDirectories: directories, get }),
      ...splitArguments(get<string | string[]>('arguments', this.profile.defaultArguments)), file,
    ];
    if (useWsl) {
      args = ['--cd', serverCwd, '--exec', executable, ...args];
      executable = 'wsl';
    }
    this.logger.info(`${this.name}: ${JSON.stringify([executable, ...args])} (cwd: ${cwd})`);
    const result = await this.execute(executable, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, args);
    if (this.disposed) { return { diagnostics: [], clearExisting: false }; }
    const output = this.profile.output === 'both' ? `${result.stdout}\n${result.stderr}` : result[this.profile.output];
    const parsed = parseDiagnostics(this.profile, output);
    if (result.error && (parsed.length === 0 || result.error.killed || result.error.signal || typeof result.error.code === 'string')) {
      throw new Error(`${this.name}: ${result.error.message}\n${result.stderr || result.stdout}`);
    }
    const files = new Map<string, vscode.Diagnostic[]>();
    // Always clear the requested document after a successful clean run.
    files.set(document.fileName, []);
    for (const issue of parsed) {
      const filename = useWsl
        ? await translate(path.posix.resolve(serverCwd, issue.file), true)
        : path.resolve(cwd, issue.file);
      const diagnostics = files.get(filename) ?? [];
      diagnostics.push({
        range: new vscode.Range(issue.line, issue.column, issue.line, Number.MAX_VALUE),
        severity: SEVERITIES[issue.severity], message: issue.message,
        source: this.name, code: issue.code ?? this.name,
      });
      files.set(filename, diagnostics);
    }
    return { clearExisting: false, replaceOwned: true, diagnostics: [...files].map(([filename, diagnostics]) => ({ uri: vscode.Uri.file(filename), diagnostics })) };
  }

  /** Stops running tool processes; their pending lints resolve with no output. */
  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.processes.forEach((finish, process) => {
      try {
        terminateProcess(process);
      } catch (error) {
        this.logger.warn(`failed to stop ${this.name} process: ${String(error)}`);
      }
      finish();
    });
    this.processes.clear();
  }

  private async execute(command: string, options: child.ExecFileOptions, args: string[]): Promise<CommandResult> {
    if (this.disposed) { return { error: null, stdout: '', stderr: '' }; }
    return new Promise<CommandResult>((resolve) => {
      let process: child.ChildProcess | undefined;
      let completed = false;
      const finish = (error: child.ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer): void => {
        if (completed) { return; }
        completed = true;
        if (process !== undefined) { this.processes.delete(process); }
        resolve({ error, stdout: stdout.toString(), stderr: stderr.toString() });
      };
      try {
        process = executeFile(command, args, options, finish);
        if (!completed) { this.processes.set(process, () => finish(null, '', '')); }
      } catch (error) {
        resolve({ error: error as child.ExecFileException, stdout: '', stderr: '' });
      }
    });
  }
}
