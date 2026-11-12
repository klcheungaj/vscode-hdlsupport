import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { LspStdioClient } from '../e2e/helpers/lspClient';

const PAYLOAD_BYTES = 16 * 1024 * 1024;

/** Read mimalloc v2/v3's peak committed bytes, not the OS process RSS. */
export function mimallocPeakCommitted(stderr: string): number {
    if (!/mimalloc: process init:/.test(stderr)) {
        throw new Error('The executable did not emit mimalloc runtime initialization output.');
    }
    const match = /^\s*committed\s*:[ \t]*([^\r\n]+)/m.exec(stderr);
    if (!match) {
        throw new Error('Missing or unrecognized mimalloc committed-memory statistics.');
    }
    const units: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
    const [peak, unit] = match[1].trim().split(/\s+/);
    const multiplier = unit === undefined || /^\d/.test(unit) ? 1 : units[unit];
    const bytes = Number(peak) * multiplier;
    if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error('Mimalloc reported no committed memory: linking the library alone is insufficient.');
    }
    return bytes;
}

async function measureProtocolAllocations(binary: string, cwd: string, payloadBytes: number): Promise<number> {
    // Do not inherit allocator tuning or preload variables from a developer's
    // shell: the binary itself must supply the allocator being measured.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith('MIMALLOC_') && !['LD_PRELOAD', 'LD_LIBRARY_PATH'].includes(key)));
    const client = LspStdioClient.spawn(binary, [], {
        cwd,
        env: { ...env, TOKIO_WORKER_THREADS: '2', MIMALLOC_SHOW_STATS: '1', MIMALLOC_VERBOSE: '1' },
        requestTimeoutMs: 30_000,
    });
    try {
        await client.request('initialize', {
            processId: null, rootUri: null, workspaceFolders: [], capabilities: {},
            clientInfo: { name: 'allocator-contract' + 'x'.repeat(payloadBytes) },
            initializationOptions: { llg: { protocolVersion: 1, configFiles: [] } },
        });
        client.notify('initialized', {});
        const exit = await client.stop();
        const stderr = client.getStderrTail(200).join('\n');
        if (exit.code !== 0 || exit.signal !== null) {
            throw new Error(`${binary} failed its allocator LSP lifecycle: ${JSON.stringify(exit)}\n${stderr}`);
        }
        return mimallocPeakCommitted(stderr);
    } finally {
        await client.kill();
    }
}

/**
 * Exercise ordinary LSP/JSON allocations in the exact (possibly stripped)
 * artifact. Positive stats alone could come from a linked but unused allocator;
 * peak commitment must grow with a large protocol payload as well.
 * This tests the server's default Rust allocation path, not every internal
 * libc allocation or every C/C++ call site in a linked third-party library.
 */
export async function assertMimallocProtocolAllocations(binary: string): Promise<void> {
    const cwd = await mkdtemp(join(tmpdir(), 'hdl-allocator-contract-'));
    try {
        const baseline = await measureProtocolAllocations(binary, cwd, 0);
        const loaded = await measureProtocolAllocations(binary, cwd, PAYLOAD_BYTES);
        // Allow for rounding and allocator page reuse, but require a response
        // commensurate with the payload rather than incidental startup work.
        if (loaded - baseline < PAYLOAD_BYTES / 2) {
            throw new Error(`${binary}: protocol payload did not allocate through mimalloc `
                + `(peak committed bytes: baseline=${baseline}, loaded=${loaded}).`);
        }
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
}
