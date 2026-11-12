{
const { defineConfig: defineBinaryVitestConfig } = require('vitest/config') as typeof import('vitest/config');

// Explicit native-artifact checks; normal npm test does not require binaries
// on Windows/macOS or enforce release linkage on local GNU development builds.
module.exports = defineBinaryVitestConfig({
    test: {
        environment: 'node',
        include: ['src/test/e2e/serverBinaries.e2e.test.ts'],
        pool: 'forks',
        testTimeout: 30_000,
    },
});
}
