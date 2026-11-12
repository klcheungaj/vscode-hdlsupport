import { describe, expect, it } from 'vitest';
import { mimallocPeakCommitted } from './mimalloc';

describe('mimalloc runtime evidence', () => {
    it.each([
        ['committed : 97.5 MiB 97.8 MiB 23.5 MiB', 97.5 * 1024 ** 2],
        ['committed: 512.0 k 512.0 k 0', 512 * 1024],
        ['committed : 4096 B 4096 B 0', 4096],
    ])('reads the allocator peak from %s', (row, bytes) => {
        expect(mimallocPeakCommitted(`mimalloc: process init: 0x1234\n  ${row}\n`)).toBe(bytes);
    });

    it.each([
        '',
        'mi_malloc\nmi_free\nMIMALLOC_SHOW_STATS',
        'committed : 100 MiB 100 MiB 0\n',
        'mimalloc: process init: 0x1234\nprocess: peak rss: 100 MiB\n',
        'mimalloc: process init: 0x1234\ncommitted : 0 B 0 B 0\n',
        'mimalloc: process init: 0x1234\ncommitted : 12 mystery-units\n',
    ])('rejects absent, inactive or unrecognized allocator evidence: %s', output => {
        expect(() => mimallocPeakCommitted(output)).toThrow();
    });
});
