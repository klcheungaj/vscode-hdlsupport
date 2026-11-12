// SPDX-License-Identifier: MIT

import * as net from 'net';
import * as path from 'path';

const REMOTE_CONTAINERS_ENV = 'REMOTE_CONTAINERS';
const REMOTE_CONTAINERS_DISPLAY_SOCKET_ENV = 'REMOTE_CONTAINERS_DISPLAY_SOCK';
const ALLOW_FORWARDED_DISPLAY_ENV = 'HDLSUPPORT_E2E_ALLOW_FORWARDED_DISPLAY';

type DisplayCheck =
    | { available: true }
    | { available: false; reason: string };

export type DisplayPreflightDecision =
    | { kind: 'allow' }
    | { kind: 'probe'; display: string; endpoint: DisplayEndpoint }
    | { kind: 'skip'; reason: string };

export type DisplayEndpoint =
    | { kind: 'unix'; path: string }
    | { kind: 'tcp'; host: string; port: number };

function displaySocket(display: string): string | undefined {
    // Linux's local X11 display form is `:N` or `unix/:N`. The optional
    // screen suffix does not affect the UNIX socket name.
    const local = display.match(/^(?:unix\/)?:(\d+)(?:\.\d+)?$/);
    if (local) {
        return `/tmp/.X11-unix/X${local[1]}`;
    }
    return undefined;
}

function displayTcpEndpoint(display: string): { host: string; port: number } | undefined {
    const match = display.match(/^(?:tcp\/)?([^:]+):(\d+)(?:\.\d+)?$/);
    if (!match) {
        return undefined;
    }
    const displayNumber = Number.parseInt(match[2], 10);
    const port = 6000 + displayNumber;
    if (!Number.isSafeInteger(displayNumber) || port > 65_535) {
        return undefined;
    }
    return { host: match[1], port };
}

function isEnabled(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function forwardedDisplaySocket(env: Readonly<Record<string, string | undefined>>): string | undefined {
    const socket = env[REMOTE_CONTAINERS_DISPLAY_SOCKET_ENV]?.trim();
    return socket ? path.normalize(socket) : undefined;
}

function hasRemoteDisplayForwarding(
    env: Readonly<Record<string, string | undefined>>,
    display: string,
): boolean {
    const forwardedSocket = forwardedDisplaySocket(env);
    if (forwardedSocket === undefined) {
        // REMOTE_CONTAINERS alone identifies the execution context, not the
        // owner of a local UNIX display. This keeps `xvfb-run` usable inside a
        // remote container while still recognizing remote TCP displays below.
        return isEnabled(env[REMOTE_CONTAINERS_ENV]) && displaySocket(display) === undefined;
    }

    const localSocket = displaySocket(display);
    // xvfb-run changes DISPLAY to its own local socket. A stale forwarded
    // socket marker must not make that real local X server ineligible.
    return localSocket === undefined || path.normalize(localSocket) === forwardedSocket;
}

/** Pure Linux display policy used by both GUI runners and its unit tests. */
export function decideDisplayPreflight(
    env: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform,
): DisplayPreflightDecision {
    if (platform !== 'linux') {
        return { kind: 'allow' };
    }

    const display = env.DISPLAY?.trim();
    if (!display) {
        return { kind: 'skip', reason: 'DISPLAY is unset' };
    }

    if (hasRemoteDisplayForwarding(env, display) && env[ALLOW_FORWARDED_DISPLAY_ENV] !== '1') {
        const forwardedSocket = forwardedDisplaySocket(env);
        const forwardingDetail = forwardedSocket === undefined
            ? `REMOTE_CONTAINERS=${env[REMOTE_CONTAINERS_ENV] ?? 'true'}`
            : `${REMOTE_CONTAINERS_DISPLAY_SOCKET_ENV}=${forwardedSocket}`;
        return {
            kind: 'skip',
            reason: `DISPLAY=${display} is associated with remote/container display forwarding (${forwardingDetail}); `
                + `skipped before Electron because a socket connection is not proof of an X server. `
                + `Set ${ALLOW_FORWARDED_DISPLAY_ENV}=1 only after independently verifying it, or run under xvfb-run`,
        };
    }

    const socket = displaySocket(display);
    const tcp = socket === undefined ? displayTcpEndpoint(display) : undefined;
    const endpoint: DisplayEndpoint | undefined = socket !== undefined
        ? { kind: 'unix', path: socket }
        : tcp !== undefined
            ? { kind: 'tcp', ...tcp }
            : undefined;
    if (endpoint === undefined) {
        return { kind: 'skip', reason: `DISPLAY=${display} is not a supported X11 endpoint` };
    }

    return { kind: 'probe', display, endpoint };
}

/** Probes an X11 endpoint without attempting an unauthenticated setup handshake. */
async function probeDisplay(endpoint: DisplayEndpoint): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const connection = endpoint.kind === 'unix'
            ? net.createConnection({ path: endpoint.path })
            : net.createConnection({ host: endpoint.host, port: endpoint.port });
        let settled = false;
        const finish = (available: boolean): void => {
            if (settled) {
                return;
            }
            settled = true;
            connection.destroy();
            resolve(available);
        };
        connection.once('connect', () => {
            // This is endpoint screening only. Do not send an X11 setup
            // request or inspect Xauthority here; Electron/VS Code must make
            // the real authenticated connection (including xvfb-run cookies).
            finish(true);
        });
        connection.once('error', () => finish(false));
        connection.once('close', () => finish(false));
        connection.setTimeout(1_000, () => finish(false));
    });
}

export async function checkDisplay(
    env: Readonly<Record<string, string | undefined>> = process.env,
    platform: NodeJS.Platform = process.platform,
): Promise<DisplayCheck> {
    const decision = decideDisplayPreflight(env, platform);
    if (decision.kind === 'skip') {
        return { available: false, reason: decision.reason };
    }
    if (decision.kind === 'allow') {
        return { available: true };
    }

    const available = await probeDisplay(decision.endpoint);
    return available
        ? { available: true }
        : { available: false, reason: `X11 endpoint for DISPLAY=${decision.display} is unavailable` };
}

/** Throws when an invoked GUI test cannot create a usable desktop window. */
export async function requireDisplayForGuiTest(testName: string): Promise<void> {
    const display = await checkDisplay();
    if (display.available) {
        return;
    }
    throw new Error(
        `[${testName}] no usable GUI display is available: ${display.reason}. `
        + `On Linux, run the test under 'xvfb-run -a' or provide a verified X11 display.`,
    );
}
