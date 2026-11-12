import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export interface LspNotification {
    method: string;
    params: unknown;
}

/** Notification enriched with its arrival index in the client's history. */
export interface IndexedNotification extends LspNotification {
    readonly index: number;
}

export interface ExitInfo {
    code: number | null;
    signal: string | null;
}

export interface SpawnLspOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Default per-request timeout in milliseconds. */
    requestTimeoutMs?: number;
}

interface JsonRpcResponse {
    jsonrpc?: string;
    id?: number | string | null;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = { method: string; params?: unknown; id?: number | string | null } & JsonRpcResponse;

interface PendingRequest {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

const POLL_INTERVAL_MS = 50;

/** Thrown when the server process exits (or fails to start) while work is pending. */
export class TransportClosedError extends Error {
    constructor(message: string, readonly stderrTail: readonly string[]) {
        super(message);
        this.name = 'TransportClosedError';
    }
}

/**
 * Minimal promise-based Language Server Protocol client speaking
 * Content-Length framed JSON-RPC over a child process's stdio. Pure Node,
 * no external dependencies.
 *
 * Notifications are collected into an array; `waitForNotification` only ever
 * inspects messages that arrived after the call was made, so stale history
 * can never satisfy a new wait.
 */
export class LspStdioClient {
    private readonly child: ChildProcess;
    private buffer: Buffer = Buffer.alloc(0);
    private nextId = 1;
    private readonly pending = new Map<number | string, PendingRequest>();
    private readonly received: IndexedNotification[] = [];
    private readonly events = new EventEmitter();
    private readonly stderrLines: string[] = [];
    private stderrPartial = '';
    private exitInfo: ExitInfo | null = null;
    private readonly exitWaiters: Array<(info: ExitInfo) => void> = [];
    private readonly defaultRequestTimeoutMs: number;
    private killed = false;

    private constructor(child: ChildProcess, defaultRequestTimeoutMs: number) {
        this.child = child;
        this.defaultRequestTimeoutMs = defaultRequestTimeoutMs;

        child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
        child.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
        child.on('error', (error: Error) =>
            this.onExit({ code: null, signal: `spawn-error: ${error.message}` }));
        // Wait for stdio to drain as well as process exit so final diagnostics
        // (including allocator statistics) are available to callers of stop().
        child.on('close', (code: number | null, signal: string | null) => this.onExit({ code, signal }));
        // EPIPE on stdin while the server is shutting down must not crash the test runner.
        child.stdin?.on('error', () => undefined);
    }

    static spawn(command: string, args: ReadonlyArray<string> = [], options: SpawnLspOptions = {}): LspStdioClient {
        const child = spawn(command, [...args], {
            cwd: options.cwd,
            env: options.env ?? process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return new LspStdioClient(child, options.requestTimeoutMs ?? 30_000);
    }

    get pid(): number | undefined {
        return this.child.pid;
    }

    get exited(): boolean {
        return this.exitInfo !== null;
    }

    /** Snapshot of every notification received so far, oldest first. */
    getNotifications(): IndexedNotification[] {
        return [...this.received];
    }

    /** Number of notifications received so far (used to derive future-only cursors). */
    get notificationCount(): number {
        return this.received.length;
    }

    /** Registers a listener for every subsequent notification. Returns an unsubscribe function. */
    onNotification(listener: (notification: LspNotification) => void): () => void {
        this.events.on('notification', listener);
        return () => this.events.off('notification', listener);
    }

    /**
     * Resolves with the first notification matching `method` (+ optional predicate)
     * that arrives AFTER this call. Stale messages are never considered.
     *
     * `fromIndex` overrides the implicit cursor: pass `notificationCount` captured
     * BEFORE sending a trigger message so a reply racing ahead of this call still matches.
     */
    async waitForNotification(
        method: string,
        predicate?: (params: unknown) => boolean,
        timeoutMs: number = this.defaultRequestTimeoutMs,
        fromIndex?: number,
    ): Promise<IndexedNotification> {
        let index = Math.max(0, Math.min(fromIndex ?? this.received.length, this.received.length));
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            for (; index < this.received.length; index++) {
                const notification = this.received[index];
                if (notification.method === method && (!predicate || predicate(notification.params))) {
                    return notification;
                }
            }
            if (this.exitInfo !== null) {
                throw new TransportClosedError(
                    `server exited while waiting for ${method}`,
                    this.getStderrTail(),
                );
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(
                    `timed out after ${timeoutMs}ms waiting for notification ${method}` +
                    `${predicate ? ' (with predicate)' : ''}`,
                );
            }
            await delay(Math.min(POLL_INTERVAL_MS, remaining));
        }
    }

    /** Sends a JSON-RPC request and resolves with the `result` of its response. */
    request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
        const effectiveTimeout = timeoutMs ?? this.defaultRequestTimeoutMs;
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(
                    `timed out after ${effectiveTimeout}ms waiting for response to ${method}` +
                    ` (id ${id})`,
                ));
            }, effectiveTimeout);
            this.pending.set(id, {
                resolve: resolve as (result: unknown) => void,
                reject,
                timer,
            });
            try {
                this.send({ jsonrpc: '2.0', id, method, params });
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    /** Sends a JSON-RPC notification without waiting for anything. */
    notify(method: string, params?: unknown): void {
        this.send({ jsonrpc: '2.0', method, params });
    }

    /** Tail of everything the server wrote to stderr (for failure diagnostics). */
    getStderrTail(maxLines = 20): string[] {
        return this.stderrLines.slice(-maxLines);
    }

    /** Resolves when the server process exits, rejecting after `timeoutMs`. */
    async waitForExit(timeoutMs: number): Promise<ExitInfo> {
        if (this.exitInfo !== null) {
            return this.exitInfo;
        }
        return new Promise<ExitInfo>((resolve, reject) => {
            const timer = setTimeout(() => {
                const index = this.exitWaiters.indexOf(resolve);
                if (index >= 0) {
                    this.exitWaiters.splice(index, 1);
                }
                reject(new Error(`server did not exit within ${timeoutMs}ms`));
            }, timeoutMs);
            this.exitWaiters.push((info) => {
                clearTimeout(timer);
                resolve(info);
            });
        });
    }

    /** Graceful lifecycle: shutdown request, exit notification, stdin EOF, wait for process end. */
    async stop(graceMs = 10_000): Promise<ExitInfo> {
        const startedAt = Date.now();
        try {
            await this.request('shutdown', null, Math.min(5_000, graceMs));
        } catch {
            // The server may already be gone or may not answer; fall through to exit.
        }
        try {
            this.notify('exit');
        } catch {
            // Ignore: stdin may already be closed.
        }
        // tower-lsp ends its serve loop on EOF as well; real clients close the pipe.
        try {
            this.child.stdin?.end();
        } catch {
            // Ignore: already closed.
        }
        const remaining = Math.max(1_000, graceMs - (Date.now() - startedAt));
        try {
            return await this.waitForExit(remaining);
        } catch {
            return this.kill();
        }
    }

    /** Forceful termination. */
    async kill(): Promise<ExitInfo> {
        if (this.exitInfo === null && !this.killed) {
            this.killed = true;
            try {
                this.child.kill('SIGKILL');
            } catch {
                // Already gone.
            }
        }
        try {
            return await this.waitForExit(5_000);
        } catch {
            return { code: null, signal: 'wait-timeout' };
        }
    }

    private onData(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const frame = this.tryReadFrame();
            if (frame === null) {
                break;
            }
            let message: JsonRpcMessage;
            try {
                message = JSON.parse(frame.toString('utf8')) as JsonRpcMessage;
            } catch (error) {
                throw new Error(`invalid JSON-RPC body from server: ${String(error)}`);
            }
            this.dispatch(message);
        }
    }

    private tryReadFrame(): Buffer | null {
        const separator = this.buffer.indexOf('\r\n\r\n');
        if (separator < 0) {
            return null;
        }
        const header = this.buffer.slice(0, separator).toString('ascii');
        const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
        if (match === null) {
            throw new Error(`malformed LSP headers from server: ${JSON.stringify(header)}`);
        }
        const length = Number.parseInt(match[1], 10);
        const bodyStart = separator + 4;
        if (this.buffer.length < bodyStart + length) {
            return null;
        }
        const body = this.buffer.slice(bodyStart, bodyStart + length);
        this.buffer = this.buffer.slice(bodyStart + length);
        return body;
    }

    private dispatch(message: JsonRpcMessage): void {
        if (typeof message.method === 'string') {
            if (message.id !== undefined && message.id !== null) {
                // Server-to-client request. Answer null so tower-lsp servers never block
                // on capabilities we do not implement (mirrors the llg stdio harness).
                this.sendSafe({ jsonrpc: '2.0', id: message.id, result: null });
                return;
            }
            const notification: IndexedNotification = {
                method: message.method,
                params: message.params,
                index: this.received.length,
            };
            this.received.push(notification);
            this.events.emit('notification', notification);
            return;
        }
        if (message.id !== undefined && message.id !== null) {
            const pending = this.pending.get(message.id);
            if (pending === undefined) {
                return;
            }
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error !== undefined) {
                pending.reject(new Error(`LSP error for id ${String(message.id)}: ${message.error.message}`));
            } else {
                pending.resolve(message.result);
            }
        }
    }

    private send(message: Record<string, unknown>): void {
        const stdin = this.child.stdin;
        if (stdin === null || stdin.destroyed || this.exitInfo !== null) {
            throw new TransportClosedError('cannot send: server transport is closed', this.getStderrTail());
        }
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
        stdin.write(Buffer.concat([header, body]));
    }

    private sendSafe(message: Record<string, unknown>): void {
        try {
            this.send(message);
        } catch {
            // Best-effort replies must not break the reader loop.
        }
    }

    private onStderr(chunk: Buffer): void {
        // Pipes can split a line at any byte; keep the unfinished line until
        // another chunk arrives or stdio closes.
        const lines = (this.stderrPartial + chunk.toString('utf8')).split(/\r?\n/);
        this.stderrPartial = lines.pop() ?? '';
        this.stderrLines.push(...lines.filter(line => line.length > 0));
        if (this.stderrLines.length > 200) {
            this.stderrLines.splice(0, this.stderrLines.length - 200);
        }
    }

    private onExit(info: ExitInfo): void {
        if (this.exitInfo !== null) {
            return;
        }
        if (this.stderrPartial.length > 0) {
            this.stderrLines.push(this.stderrPartial);
            this.stderrPartial = '';
        }
        this.exitInfo = info;
        for (const [id, pending] of Array.from(this.pending.entries())) {
            clearTimeout(pending.timer);
            pending.reject(new TransportClosedError(`server exited before responding to request id ${id}`, this.getStderrTail()));
        }
        this.pending.clear();
        const waiters = this.exitWaiters.splice(0, this.exitWaiters.length);
        for (const waiter of waiters) {
            waiter(info);
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
