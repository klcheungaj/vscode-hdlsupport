import * as path from 'path';
import { describe, it } from 'vitest';
import { assertExecutableLinkage } from '../support/executableLinkage';
import { assertMimallocProtocolAllocations } from '../support/mimalloc';
import { bundledServerPath } from '../support/extensionUnderTest';

// This explicit artifact lane never skips missing executables or inspection
// tools. Non-Linux builds can be supplied without adding a packaging target.
for (const [name, override] of [
    ['llg_ls', process.env.HDLSUPPORT_LLG_BINARY],
    ['softbrush_ls', process.env.HDLSUPPORT_SOFTBRUSH_BINARY],
] as const) {
    const binary = path.resolve(override ?? bundledServerPath(name));
    describe(`executable contract: ${name}`, () => {
        it('links only the permitted platform libraries', async () => {
            await assertExecutableLinkage(binary);
        });
        if (process.platform === 'linux') {
            it('uses mimalloc for default protocol allocations', async () => {
                await assertMimallocProtocolAllocations(binary);
            }, 90_000);
        }
    });
}
