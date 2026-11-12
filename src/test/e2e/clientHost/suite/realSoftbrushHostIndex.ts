// SPDX-License-Identifier: MIT

import * as path from 'path';

interface MinimalMocha {
    addFile(file: string): void;
    run(callback: (failures: number) => void): unknown;
}

function loadMocha(): new (options?: { ui?: string; color?: boolean; timeout?: number }) => MinimalMocha {
    return require('mocha');
}

/** @vscode/test-electron entry point for the production-client/real-Softbrush probe. */
export function run(): Promise<void> {
    const mochaCtor = loadMocha();
    const mocha = new mochaCtor({
        ui: 'bdd',
        color: true,
        timeout: 120_000,
    });
    mocha.addFile(path.resolve(__dirname, 'realSoftbrushHostSuite.js'));
    return new Promise<void>((resolve, reject) => {
        mocha.run((failures) => {
            if (failures > 0) {
                reject(new Error(`${failures} real-Softbrush client-host test(s) failed`));
            } else {
                resolve();
            }
        });
    });
}
