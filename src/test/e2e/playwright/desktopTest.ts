// SPDX-License-Identifier: MIT

import { test as base, expect, type TestInfo } from '@playwright/test';

import { launchDesktopSession, type DesktopSession } from './desktopHarness';

export const test = base.extend<{ desktop: DesktopSession }>({
    desktop: async ({}, use, testInfo: TestInfo) => {
        const desktop = await launchDesktopSession();
        let testError: unknown;
        try {
            await use(desktop);
        } catch (error) {
            testError = error;
        }

        let diagnosticsError: unknown;
        if (testError !== undefined || testInfo.status !== testInfo.expectedStatus) {
            try {
                await desktop.captureDiagnostics(testInfo);
            } catch (error) {
                diagnosticsError = error;
            }
        }

        let disposeError: unknown;
        try {
            await desktop.dispose();
        } catch (error) {
            disposeError = error;
        }

        const errors = [testError, diagnosticsError, disposeError].filter(
            (error): error is unknown => error !== undefined,
        );
        if (errors.length === 1) {
            throw errors[0];
        }
        if (errors.length > 1) {
            throw new AggregateError(errors, 'Playwright desktop test and teardown failed');
        }
    },
});

export { expect };
