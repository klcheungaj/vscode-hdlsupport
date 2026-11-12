{
const path = require('path') as typeof import('path');
const { defineConfig: definePackageVitestConfig } = require('vitest/config') as typeof import('vitest/config');

const packageArchive = path.resolve(__dirname, 'hdl-support-linux-x64.vsix');

// This lane is intentionally explicit: it validates the artifact produced by
// `npm run package:linux-x64`, rather than making `npm test` depend on one.
if (!require('fs').existsSync(packageArchive)) {
    throw new Error(
        `no packaged VSIX was found at ${packageArchive}; `
        + 'run npm run package:linux-x64 before the package contract.',
    );
}

module.exports = definePackageVitestConfig({
    test: {
        environment: 'node',
        include: ['src/test/e2e/vsixContents.e2e.test.ts'],
        exclude: [
            'node_modules/**',
            'dist/**',
            'out/**',
            '.vscode-test/**',
            'lapligence/**',
        ],
        pool: 'forks',
    },
});
}
