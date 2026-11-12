import * as path from 'path';

/**
 * Entry point required by @vscode/test-electron: the module referenced via
 * `extensionTestsPath` must export `run()` returning a promise that rejects
 * on test failure.
 *
 * The `mocha` package is loaded through require() with a narrow structural
 * type so that compiling this file does not pull @types/mocha globals into
 * the project (they would clash with Jest's ambient test globals).
 */
interface MinimalMocha {
    addFile(file: string): void;
    run(callback: (failures: number) => void): unknown;
}

function loadMocha(): new (options?: { ui?: string; color?: boolean; timeout?: number }) => MinimalMocha {
    // Loaded lazily: only needed when actually running inside the electron host
    // (see clientHost/README.md for the host-runner prerequisites).
    return require('mocha');
}

export function run(): Promise<void> {
    const mochaCtor = loadMocha();
    const mocha = new mochaCtor({
        ui: 'bdd',
        color: true,
        timeout: 120_000,
    });
    mocha.addFile(path.resolve(__dirname, 'hostSuite.js'));
    return new Promise<void>((resolve, reject) => {
        mocha.run((failures) => {
            if (failures > 0) {
                reject(new Error(`${failures} client-host test(s) failed`));
            } else {
                resolve();
            }
        });
    });
}
