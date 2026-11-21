{
const { defineConfig: definePackageVitestConfig } = require('vitest/config') as typeof import('vitest/config');

// This lane is intentionally explicit: it validates the VSIX produced by
// `npm run package:target -- --target <target>` (HDLSUPPORT_PACKAGE_TARGET,
// default linux-x64), rather than making `npm test` depend on one. The suite
// itself fails with a clear error when that VSIX is missing.

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
