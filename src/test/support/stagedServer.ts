// SPDX-License-Identifier: MIT

import * as path from 'path';
import { bundledBinaryName } from '../../languageServer/resolve';

// Resolves to the repository root from both src/test/support and the
// compiled out/test/support.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Path of the server `npm run stage:*` staged for this host (`server/<platform>-<arch>/`). */
export function stagedServerPath(binary: string): string {
    return path.join(REPO_ROOT, 'server', `${process.platform}-${process.arch}`, bundledBinaryName(binary, process.platform));
}
