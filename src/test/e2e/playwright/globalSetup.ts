// SPDX-License-Identifier: MIT

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Compile the fake stdio server before Playwright workers load the harness. */
export default function globalSetup(): void {
    const tsc = path.resolve(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!fs.existsSync(tsc)) {
        throw new Error('TypeScript is missing; install dependencies before running the Playwright desktop suite.');
    }
    execFileSync(process.execPath, [
        tsc,
        '-p',
        path.join(REPO_ROOT, 'tsconfig.tests.json'),
    ], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        windowsHide: true,
    });
}
