// SPDX-License-Identifier: MIT

import * as fs from 'fs';
import * as path from 'path';
import type { Locator, Page } from '@playwright/test';

import { expect, test } from './desktopTest';

const READY_TIMEOUT_MS = 45_000;
const RESTART_TIMEOUT_MS = 20_000;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function activityBarItem(page: Page, label: string): Locator {
    return page
        .getByRole('tab', { name: label, exact: true })
        .or(page.getByRole('button', { name: label, exact: true }))
        .or(page.getByLabel(label, { exact: true }))
        .first();
}

function viewTree(page: Page, label: string): Locator {
    return page
        .getByRole('tree', { name: label, exact: true })
        .or(page.locator(`[aria-label="${label}"] [role="tree"]`))
        .first();
}

function treeItem(tree: Locator, label: string): Locator {
    return tree
        .getByRole('treeitem')
        .filter({ hasText: new RegExp(escapeRegExp(label)) })
        .first();
}

async function visibleTreeItem(tree: Locator, label: string): Promise<Locator> {
    const item = treeItem(tree, label);
    await expect(item).toBeVisible({ timeout: READY_TIMEOUT_MS });
    return item;
}

async function expandTreeItem(item: Locator): Promise<void> {
    const expanded = await item.getAttribute('aria-expanded');
    if (expanded === 'true') {
        return;
    }
    await item.focus();
    await item.press('ArrowRight');
    if (await item.getAttribute('aria-expanded') !== 'true') {
        // VS Code's renderer does not consistently route synthetic keyboard
        // events through the tree when attached over CDP. Click its semantic
        // expand control as a fallback; this is still a DOM control, not a
        // coordinate or pixel assertion.
        const twistie = item.locator('.monaco-tl-twistie');
        await expect(twistie).toBeVisible({ timeout: READY_TIMEOUT_MS });
        await twistie.click();
    }
    await expect(item).toHaveAttribute('aria-expanded', 'true', { timeout: READY_TIMEOUT_MS });
}

async function waitForTreeText(tree: Locator, text: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    await expect.poll(
        async () => (await tree.textContent()) ?? '',
        { timeout: timeoutMs, message: `tree did not expose ${JSON.stringify(text)}` },
    ).toContain(text);
}

async function openWorkspaceFile(page: Page, fileName: string): Promise<void> {
    const explorer = page.getByRole('tree', { name: 'Files Explorer', exact: true });
    await expect(explorer).toBeVisible({ timeout: READY_TIMEOUT_MS });
    const file = explorer.getByRole('treeitem', { name: fileName, exact: true });
    await expect(file).toBeVisible({ timeout: READY_TIMEOUT_MS });
    await file.dblclick();
}

function launchCount(controlDir: string): number {
    // The path is used only to read the fixture's private control file; the
    // assertion below checks the count, never the temporary path.
    try {
        return fs.readFileSync(path.join(controlDir, 'launches.log'), 'utf8')
            .split(/\r?\n/)
            .filter((line: string) => line.trim() !== '')
            .length;
    } catch {
        return 0;
    }
}

async function invokeCommand(page: Page, title: string): Promise<void> {
    const shortcut = process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P';
    await page.locator('body').press(shortcut);
    // Older VS Code versions render a hidden "select all" checkbox inside
    // the same widget. Exclude checkbox inputs so the locator cannot settle on
    // that hidden element before finding the command input.
    const input = page
        .locator('.quick-input-widget input[role="combobox"], .quick-input-widget input:not([type="checkbox"])')
        .first();
    await expect(input).toBeVisible({ timeout: READY_TIMEOUT_MS });
    await input.fill(`>${title}`);
    const option = page.getByRole('option', { name: new RegExp(escapeRegExp(title)) }).first();
    if (await option.count() > 0) {
        await expect(option).toBeVisible({ timeout: READY_TIMEOUT_MS });
    }
    await page.keyboard.press('Enter');
}

test.describe('HDL Modules desktop journey', () => {
    test('shows and clears Lapligence lint diagnostics in the Problems panel', async ({ desktop }) => {
        const page = desktop.page;
        await openWorkspaceFile(page, 'top.sv');
        await expect(page.getByRole('tab', { name: /top\.sv/ }).first()).toBeVisible({ timeout: READY_TIMEOUT_MS });

        const problemsShortcut = process.platform === 'darwin' ? 'Meta+Shift+M' : 'Control+Shift+M';
        await page.locator('body').press(problemsShortcut);
        const problems = page.locator('.markers-panel').first();
        await expect(problems).toBeVisible({ timeout: READY_TIMEOUT_MS });
        await expect.poll(
            async () => (await problems.textContent()) ?? '',
            { timeout: READY_TIMEOUT_MS, message: 'Lapligence lint diagnostic did not reach the Problems panel' },
        ).toContain('signal `unused_sig` is never used');

        // Synthetic mouse clicks over CDP do not reliably focus the editor (on
        // macOS CI the cursor never moved), so send keys to the editor's input
        // element directly: a textarea in older VS Code, an EditContext node in
        // newer builds. Retry until the tab shows unsaved changes.
        const editorInput = page
            .locator('.monaco-editor textarea.inputarea, .monaco-editor .native-edit-context')
            .first();
        await expect(async () => {
            await editorInput.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
            await editorInput.press('Space');
            await expect(page.locator('.tab.active.dirty')).toBeVisible({ timeout: 2_000 });
        }, 'typing into top.sv did not modify the document').toPass({ timeout: READY_TIMEOUT_MS });

        await expect.poll(
            async () => (await problems.textContent()) ?? '',
            { timeout: READY_TIMEOUT_MS, message: 'empty diagnostics publication did not clear the Problems panel' },
        ).not.toContain('signal `unused_sig` is never used');
    });

    test('shows instance-specific contents and restarts Lapligence from the workbench', async ({ desktop }) => {
        // Arrange
        const page = desktop.page;
        await openWorkspaceFile(page, 'top.sv');
        const topTab = page.getByRole('tab', { name: /top\.sv/ }).first();
        await expect(topTab).toBeVisible({ timeout: READY_TIMEOUT_MS });

        // Act
        const modulesActivity = activityBarItem(page, 'HDL Modules');
        await expect(modulesActivity).toBeVisible({ timeout: READY_TIMEOUT_MS });
        await modulesActivity.click();

        const hierarchy = viewTree(page, 'Module Hierarchy');
        await expect(hierarchy).toBeVisible({ timeout: READY_TIMEOUT_MS });
        const top = await visibleTreeItem(hierarchy, 'top');
        await expandTreeItem(top);
        const small = await visibleTreeItem(hierarchy, 'u_child_small');
        const wide = await visibleTreeItem(hierarchy, 'u_child_wide');
        await expandTreeItem(small);
        await visibleTreeItem(hierarchy, 'u_leaf');

        await wide.click();
        const contents = viewTree(page, 'Module Contents');
        await expect(contents).toBeVisible({ timeout: READY_TIMEOUT_MS });
        for (const group of ['Parameters', 'Input Ports', 'Output Ports', 'Signals']) {
            await visibleTreeItem(contents, group);
        }
        await waitForTreeText(contents, 'parameter int = 16');
        await waitForTreeText(contents, 'logic [15:0]');

        // Verify the same declaration renders the other instance's resolved
        // values after a normal hierarchy selection change.
        await small.click();
        await waitForTreeText(contents, 'parameter int = 8');
        await waitForTreeText(contents, 'logic [7:0]');
        await wide.click();
        await waitForTreeText(contents, 'parameter int = 16');

        const parameters = await visibleTreeItem(contents, 'Parameters');
        const inputPorts = await visibleTreeItem(contents, 'Input Ports');
        const outputPorts = await visibleTreeItem(contents, 'Output Ports');
        const signals = await visibleTreeItem(contents, 'Signals');
        await expandTreeItem(parameters);
        await expandTreeItem(inputPorts);
        await expandTreeItem(outputPorts);
        await expandTreeItem(signals);
        await waitForTreeText(contents, 'WIDTH');
        await waitForTreeText(contents, 'data');
        await waitForTreeText(contents, 'unused_sig');

        const width = await visibleTreeItem(contents, 'WIDTH');
        await width.click();
        const childTab = page.getByRole('tab', { name: /child\.sv/ }).first();
        await expect(childTab).toBeVisible({ timeout: READY_TIMEOUT_MS });
        const editor = page.locator('.monaco-editor .view-lines').first();
        await expect(editor).toBeVisible({ timeout: READY_TIMEOUT_MS });
        await expect(editor).toContainText('module child');

        const beforeRestart = launchCount(desktop.controlDir);
        await invokeCommand(page, 'HDL Support: [Lapligence] Restart Language Server');
        await expect.poll(
            () => launchCount(desktop.controlDir),
            { timeout: RESTART_TIMEOUT_MS, message: 'Lapligence restart did not launch a new fake server' },
        ).toBeGreaterThan(beforeRestart);

        // Assert
        await expect(topTab).toBeVisible({ timeout: READY_TIMEOUT_MS });
        await expect(childTab).toBeVisible({ timeout: READY_TIMEOUT_MS });
    });
});
