{
const path = require('path') as typeof import('path');
const { defineConfig: definePackageVitestConfig } = require('vitest/config') as typeof import('vitest/config');

// HDLSUPPORT_PACKAGE_TARGET selects which platform VSIX to validate.
const packageTarget = process.env.HDLSUPPORT_PACKAGE_TARGET ?? 'linux-x64';
const packageArchive = path.resolve(__dirname, `hdl-support-${packageTarget}.vsix`);

// This lane is intentionally explicit: it validates the artifact produced by
// `npm run package:target -- --target <target>`, rather than making `npm test`
// depend on one.
if (!require('fs').existsSync(packageArchive)) {
    throw new Error(
        `no packaged VSIX was found at ${packageArchive}; `
        + `run npm run package:target -- --target ${packageTarget} before the package contract.`,
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
