// SPDX-License-Identifier: MIT

/**
 * Wait for the VS Code update service to start answering (test-electron's default
 * is 15 s). Cold CI runners regularly need longer to resolve `stable`.
 */
export const VSCODE_DOWNLOAD_TIMEOUT_MS = 120_000;
