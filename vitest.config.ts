const { defineConfig: defineVitestConfig } = require('vitest/config') as typeof import('vitest/config');

/**
 * `vscode` is provided by the VS Code host and is intentionally not installed
 * as a normal Node dependency. The unit tests provide per-file mocks, so make
 * the module resolvable without imposing one global mock shape on them.
 */
const virtualVscodeModule = {
    name: 'virtual-vscode-module',
    resolveId(id: string): string | undefined {
        return id === 'vscode' ? id : undefined;
    },
};

module.exports = defineVitestConfig({
    plugins: [virtualVscodeModule],
    test: {
        environment: 'node',
        include: ['src/test/**/*.test.ts'],
        exclude: [
            'node_modules/**',
            'dist/**',
            'out/**',
            '.vscode-test/**',
            'lapligence/**',
            // Raw stdio and VSIX/package checks belong to the contract lane.
            // Keep the pure client-host display-policy test (`runTest.test.ts`)
            // in this fast lane; it does not launch Electron.
            'src/test/e2e/**/*.e2e.test.ts',
        ],
        // The stdio suites spawn real processes, and the linter tests mock
        // child_process. Forks preserve Node process semantics for both.
        pool: 'forks',
    },
});
