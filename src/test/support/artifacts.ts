// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';

const ARTIFACT_DIRECTORY_ENV = 'HDLSUPPORT_E2E_ARTIFACT_DIR';

interface DiagnosticFile {
    readonly name: string;
    readonly path: string;
}

interface DiagnosticText {
    readonly name: string;
    readonly content: string;
}

function diagnosticDirectory(namespace: string): string | undefined {
    const configured = process.env[ARTIFACT_DIRECTORY_ENV]?.trim();
    if (configured === undefined || configured === '') {
        return undefined;
    }

    const safeNamespace = namespace.replace(/[^a-zA-Z0-9._-]/g, '-');
    const directory = path.resolve(configured, `${safeNamespace}-${process.pid}`);
    try {
        fs.mkdirSync(directory, { recursive: true });
        return directory;
    } catch (error) {
        console.warn(`[e2e] could not create diagnostic directory ${directory}: ${String(error)}`);
        return undefined;
    }
}

/** Copies selected failure files to a CI-owned directory before fixture teardown. */
export function persistDiagnosticFiles(namespace: string, files: readonly DiagnosticFile[]): void {
    const directory = diagnosticDirectory(namespace);
    if (directory === undefined) {
        return;
    }

    for (const file of files) {
        try {
            if (fs.statSync(file.path).isFile()) {
                fs.copyFileSync(file.path, path.join(directory, path.basename(file.name)));
            }
        } catch {
            // A diagnostic is best-effort: the test result must retain the
            // original failure even when a process exited before writing it.
        }
    }
}

/** Writes captured process output to a CI-owned directory. */
export function persistDiagnosticText(namespace: string, files: readonly DiagnosticText[]): void {
    const directory = diagnosticDirectory(namespace);
    if (directory === undefined) {
        return;
    }

    for (const file of files) {
        try {
            fs.writeFileSync(path.join(directory, path.basename(file.name)), file.content);
        } catch (error) {
            console.warn(`[e2e] could not write diagnostic ${file.name}: ${String(error)}`);
        }
    }
}

/** Copies a diagnostic directory such as VS Code's user-data logs. */
export function persistDiagnosticDirectory(namespace: string, name: string, source: string): void {
    const directory = diagnosticDirectory(namespace);
    if (directory === undefined) {
        return;
    }

    try {
        if (fs.statSync(source).isDirectory()) {
            fs.cpSync(source, path.join(directory, path.basename(name)), { recursive: true });
        }
    } catch {
        // See persistDiagnosticFiles: diagnostics must not mask the test error.
    }
}
