// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';

import { LspStdioClient } from './lspClient';

/** A tiny framed server used to exercise the production-parity transport. */
const SERVER_SCRIPT = String.raw`
let buffer = Buffer.alloc(0);
const outputQueue = [];
let outputActive = false;
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'), body]);
  outputQueue.push(frame);
  flushOutput();
}
function flushOutput() {
  if (outputActive || outputQueue.length === 0) return;
  outputActive = true;
  const frame = outputQueue.shift();
  process.stdout.write(frame.subarray(0, 3));
  setTimeout(() => {
    process.stdout.write(frame.subarray(3));
    outputActive = false;
    flushOutput();
  }, 0);
}
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { ready: true } });
  } else if (message.method === 'emit') {
    send({ jsonrpc: '2.0', method: 'test/notification', params: message.params });
    send({ jsonrpc: '2.0', id: message.id, result: null });
  } else if (message.method === 'fail') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'intentional failure' } });
  } else if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
  } else if (message.method === 'exit') {
    process.exit(0);
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const separator = buffer.indexOf('\r\n\r\n');
    if (separator < 0) break;
    const header = buffer.subarray(0, separator).toString('ascii');
    const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
    if (!match) throw new Error('malformed request header');
    const length = Number.parseInt(match[1], 10);
    const bodyStart = separator + 4;
    if (buffer.length < bodyStart + length) break;
    const body = buffer.subarray(bodyStart, bodyStart + length);
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body.toString('utf8')));
  }
});
process.stdin.resume();
`;

const clients: LspStdioClient[] = [];

function startClient(): LspStdioClient {
    const client = LspStdioClient.spawn(process.execPath, ['-e', SERVER_SCRIPT], {
        requestTimeoutMs: 500,
    });
    clients.push(client);
    return client;
}

async function initialize(client: LspStdioClient): Promise<void> {
    await expect(client.request('initialize', { client: 'test' })).resolves.toEqual({ ready: true });
}

afterEach(async () => {
    for (const client of clients.splice(0)) {
        if (!client.exited) {
            await client.kill();
        }
    }
});

describe('LspStdioClient', () => {
    it('decodes responses split across multiple stdout chunks', async () => {
        // Arrange
        const client = startClient();

        // Act
        const result = await client.request('initialize', { client: 'test' });

        // Assert
        expect(result).toEqual({ ready: true });
    });

    it('waits only for future notifications unless an explicit cursor is supplied', async () => {
        // Arrange
        const client = startClient();
        await initialize(client);
        await client.request('emit', { value: 'old' });

        // Act / Assert
        await expect(client.waitForNotification('test/notification', undefined, 30)).rejects.toThrow(
            'timed out after 30ms',
        );
        const cursor = client.notificationCount;
        const future = client.waitForNotification('test/notification', undefined, 500, cursor);
        await client.request('emit', { value: 'new' });
        await expect(future).resolves.toMatchObject({ params: { value: 'new' }, index: cursor });
    });

    it('propagates JSON-RPC errors and request timeouts', async () => {
        // Arrange
        const client = startClient();
        await initialize(client);

        // Act / Assert
        await expect(client.request('fail')).rejects.toThrow('LSP error for id');
        await expect(client.request('never-answered', undefined, 30)).rejects.toThrow(
            'timed out after 30ms waiting for response to never-answered',
        );
    });

    it('performs a graceful shutdown and reports the child exit', async () => {
        // Arrange
        const client = startClient();
        await initialize(client);

        // Act
        const exitInfo = await client.stop(1_000);

        // Assert
        expect(exitInfo.code).toBe(0);
        expect(exitInfo.signal).toBeNull();
        expect(client.exited).toBe(true);
    });
});

it('retains complete final stderr lines across process pipe chunks and EOF', async () => {
    const client = LspStdioClient.spawn(process.execPath, ['-e', `
        process.stderr.write('mimalloc: process init: 0x1234\\ncomm');
        setTimeout(() => {
            process.stderr.write('itted : 97.5 MiB 98 MiB 20 MiB\\nfinal line without newline');
        }, 20);
    `]);
    try {
        expect(await client.waitForExit(5_000)).toEqual({ code: 0, signal: null });
        expect(client.getStderrTail()).toEqual([
            'mimalloc: process init: 0x1234',
            'committed : 97.5 MiB 98 MiB 20 MiB',
            'final line without newline',
        ]);
    } finally {
        await client.kill();
    }
});
