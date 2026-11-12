// SPDX-License-Identifier: MIT
import * as vscode from 'vscode';
import type * as child from 'child_process';
import * as path from 'path';
import { Logger } from '../logger';
import { splitArguments } from '../linter/arguments';
import { executeFile, resolveExecutable, terminateProcess } from '../linter/processExecution';
import { findFormatterProfile, formatterProfiles } from './profiles';

const SECTION = 'hdlsupport.verilog.formatting';
const DEFAULT_FORMATTER = 'verible';
const TIMEOUT_MS = 60_000;
/** The formatted document comes back on stdout, so allow more than the 1 MiB default. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Every language some formatter profile supports; the provider is registered for these. */
export const FORMATTER_LANGUAGES = [...new Set(formatterProfiles.flatMap(profile => profile.languages))];

interface CommandResult {
  error: child.ExecFileException | null;
  stdout: string;
  stderr: string;
}

/** Formats documents with the configured formatter profile, piping the document through the tool. */
export default class ProfileFormatter
  implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {
  constructor(private readonly logger: Logger) {}

  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    return this.format(document, undefined, token);
  }

  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    return this.format(document, range, token);
  }

  private async format(
    document: vscode.TextDocument,
    range: vscode.Range | undefined,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    const name = vscode.workspace.getConfiguration(SECTION, document.uri).get<string>('formatter', DEFAULT_FORMATTER);
    const profile = findFormatterProfile(name);
    if (!profile?.languages.includes(document.languageId)) {
      return [];
    }
    const settings = vscode.workspace.getConfiguration(`${SECTION}.${profile.id}`, document.uri);
    const get = <T>(key: string, fallback: T): T => settings.get<T>(key, fallback);
    const defaultExecutable = process.platform === 'win32'
      ? profile.windowsExecutable ?? `${profile.executable}.exe` : profile.executable;
    const executable = await resolveExecutable(get('path', ''), defaultExecutable);
    // A tool without range support formats the whole document instead.
    const rangeArguments = range && profile.rangeArguments
      ? profile.rangeArguments(range.start.line + 1, range.end.line + 1) : [];
    const args = [
      ...splitArguments(get<string | string[]>('arguments', profile.defaultArguments)),
      ...rangeArguments,
      ...profile.arguments({ languageId: document.languageId, get }),
    ];
    const cwd = path.dirname(document.fileName);
    const source = document.getText();
    this.logger.info(`${profile.id}: ${JSON.stringify([executable, ...args])} (cwd: ${cwd})`);

    const result = await new Promise<CommandResult | undefined>((resolve) => {
      const started = executeFile(
        executable, args, { cwd, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, input: source },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
      const cancellation = token.onCancellationRequested(() => {
        terminateProcess(started);
        resolve(undefined);
      });
      started.once('close', () => cancellation.dispose());
    });
    if (result === undefined || token.isCancellationRequested) {
      return [];
    }
    if (result.error?.code === 'ENOENT') {
      void vscode.window.showErrorMessage(
        `${profile.label} formatter '${executable}' was not found. Install it or set ${SECTION}.${profile.id}.path.`,
      );
      return [];
    }
    if (result.error) {
      this.logger.error(`${profile.id} failed: ${result.error.message}\n${result.stderr}`);
      throw new Error(`${profile.label} could not format ${path.basename(document.fileName)}: ${result.stderr.trim() || result.error.message}`);
    }
    if (result.stdout === source) {
      return [];
    }
    const whole = new vscode.Range(document.positionAt(0), document.positionAt(source.length));
    return [vscode.TextEdit.replace(whole, result.stdout)];
  }
}
