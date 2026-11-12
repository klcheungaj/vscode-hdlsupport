// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { decideDisplayPreflight } from './runTest';

describe('client-host display preflight policy', () => {
    it('skips the remote-container forwarding false positive before probing its socket', () => {
        // Arrange
        const decision = decideDisplayPreflight({
            ['DISPLAY']: ':4',
            ['REMOTE_CONTAINERS']: 'true',
            ['REMOTE_CONTAINERS_DISPLAY_SOCK']: '/tmp/.X11-unix/X4',
        }, 'linux');

        // Act / Assert
        expect(decision.kind).toBe('skip');
        if (decision.kind !== 'skip') {
            throw new Error('remote forwarding must be skipped without explicit opt-in');
        }
        expect(decision.reason).toContain('remote/container display forwarding');
        expect(decision.reason).toContain('not proof of an X server');
        expect(decision.reason).toContain('HDLSUPPORT_E2E_ALLOW_FORWARDED_DISPLAY=1');
    });

    it('leaves an explicitly opted-in forwarded endpoint eligible for endpoint screening', () => {
        // Arrange
        const decision = decideDisplayPreflight({
            ['DISPLAY']: ':4',
            ['REMOTE_CONTAINERS']: 'true',
            ['REMOTE_CONTAINERS_DISPLAY_SOCK']: '/tmp/.X11-unix/X4',
            ['HDLSUPPORT_E2E_ALLOW_FORWARDED_DISPLAY']: '1',
        }, 'linux');

        // Act / Assert
        expect(decision).toEqual({
            kind: 'probe',
            display: ':4',
            endpoint: { kind: 'unix', path: '/tmp/.X11-unix/X4' },
        });
    });

    it('requires the forwarded-display opt-in to be exactly 1', () => {
        // Arrange
        const decision = decideDisplayPreflight({
            ['DISPLAY']: ':4',
            ['REMOTE_CONTAINERS']: 'true',
            ['REMOTE_CONTAINERS_DISPLAY_SOCK']: '/tmp/.X11-unix/X4',
            ['HDLSUPPORT_E2E_ALLOW_FORWARDED_DISPLAY']: 'true',
        }, 'linux');

        // Act / Assert
        expect(decision.kind).toBe('skip');
    });

    it('keeps non-forwarded local X11 and Xvfb displays eligible for endpoint screening', () => {
        // Arrange / Act
        expect(decideDisplayPreflight({ ['DISPLAY']: ':99' }, 'linux')).toEqual({
            kind: 'probe',
            display: ':99',
            endpoint: { kind: 'unix', path: '/tmp/.X11-unix/X99' },
        });
    });

    it('keeps an xvfb display eligible when a remote marker names another socket', () => {
        // Arrange
        const decision = decideDisplayPreflight({
            ['DISPLAY']: ':99',
            ['REMOTE_CONTAINERS']: 'true',
            ['REMOTE_CONTAINERS_DISPLAY_SOCK']: '/tmp/.X11-unix/X4',
        }, 'linux');

        // Act / Assert
        expect(decision).toEqual({
            kind: 'probe',
            display: ':99',
            endpoint: { kind: 'unix', path: '/tmp/.X11-unix/X99' },
        });
    });
});
