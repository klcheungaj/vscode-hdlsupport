{
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { defineConfig: defineContractVitestConfig } = require('vitest/config') as typeof import('vitest/config');

/**
 * `vscode` is provided by the VS Code host and is intentionally not installed
 * as a normal Node dependency. Keep the same virtual module seam as the unit
 * config for any shared helper imported by a contract suite.
 */
const contractVirtualVscodeModule = {
    name: 'virtual-vscode-module',
    resolveId(id: string): string | undefined {
        return id === 'vscode' ? id : undefined;
    },
};

const serverBinary = path.resolve(__dirname, 'server', 'linux-x64', 'llg_ls');

function isEnabled(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function serverBinaryAvailable(): boolean {
    try {
        fs.accessSync(serverBinary, fs.constants.X_OK);
        return fs.statSync(serverBinary).isFile();
    } catch {
        return false;
    }
}

// Local runs retain the suites' existing missing-binary skips. CI requires an
// explicit usable artifact by default; REQUIRE_LLG=0 can be used deliberately
// for a CI job that is only inspecting the non-server portion of this config.
const requireLlg = process.env.REQUIRE_LLG === undefined
    ? isEnabled(process.env.CI)
    : isEnabled(process.env.REQUIRE_LLG);

if (requireLlg && !serverBinaryAvailable()) {
    throw new Error(
        `REQUIRE_LLG is enabled, but no executable staged language server was found at ${serverBinary}. `
        + 'Run npm run stage:server first, or set REQUIRE_LLG=0 only for an intentional non-server run.',
    );
}

module.exports = defineContractVitestConfig({
    plugins: [contractVirtualVscodeModule],
    test: {
        environment: 'node',
        include: ['src/test/e2e/**/*.e2e.test.ts'],
        exclude: [
            'node_modules/**',
            'dist/**',
            'out/**',
            '.vscode-test/**',
            'lapligence/**',
            // The package archive has its own explicit Linux packaging lane;
            // a normal checkout must not require a stale or absent VSIX.
            'src/test/e2e/vsixContents.e2e.test.ts',
            'src/test/e2e/serverBinaries.e2e.test.ts',
        ],
        // Raw suites spawn real processes and the package contract invokes
        // external tooling. Forks preserve the existing Node semantics.
        pool: 'forks',
    },
});
}
