// SPDX-License-Identifier: MIT

import * as path from 'path';
import { bundledBinaryName } from '../../languageServer/resolve';

// Resolves to the repository root from both src/test/support and the
// compiled out/test/support.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EXTENSION_PATH_ENV = 'HDLSUPPORT_E2E_EXTENSION_PATH';

/**
 * Root of the extension under test. CI sets HDLSUPPORT_E2E_EXTENSION_PATH to
 * the `extension/` folder of the unpacked VSIX so tests exercise exactly what
 * users install (production bundle, packaged files, bundled servers); local
 * runs default to the checkout and its `npm run stage:*` servers.
 */
export function extensionUnderTestPath(): string {
    const configured = process.env[EXTENSION_PATH_ENV]?.trim();
    if (!configured) {
        return REPO_ROOT;
    }
    if (!path.isAbsolute(configured)) {
        throw new Error(`${EXTENSION_PATH_ENV} must be an absolute path to an unpacked VSIX extension/ folder`);
    }
    return path.resolve(configured);
}

/** Path of this host's bundled server inside the extension under test (`server/<platform>-<arch>/`). */
export function bundledServerPath(binary: string): string {
    return path.join(
        extensionUnderTestPath(),
        'server',
        `${process.platform}-${process.arch}`,
        bundledBinaryName(binary, process.platform),
    );
}
