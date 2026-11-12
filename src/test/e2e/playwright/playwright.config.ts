// SPDX-License-Identifier: MIT

import * as path from 'path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: __dirname,
    testMatch: /\.spec\.ts$/,
    globalSetup: path.join(__dirname, 'globalSetup.ts'),
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 180_000,
    expect: {
        timeout: 15_000,
    },
    use: {
        actionTimeout: 15_000,
        navigationTimeout: 15_000,
        locale: 'en-US',
    },
});
