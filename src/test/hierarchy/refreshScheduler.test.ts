// SPDX-License-Identifier: MIT
//
// Pure unit tests for the HDL Modules explorer refresh scheduler: bursts
// collapse into one debounced sweep and a running sweep never queues more
// than one latest-wins follow-up.

import { describe, expect, it } from 'vitest';
import { RefreshScheduler } from '../../hierarchy/refreshScheduler';

describe('RefreshScheduler', () => {
    it('arms exactly one timer per idle burst', () => {
        const scheduler = new RefreshScheduler();
        expect(scheduler.quiescent).toBe(true);
        expect(scheduler.request()).toBe('arm');
        for (let i = 0; i < 10; i++) {
            expect(scheduler.request()).toBe('coalesce');
        }
        expect(scheduler.quiescent).toBe(false);
    });

    it('a burst of 10 triggers while running produces exactly one follow-up run', () => {
        const scheduler = new RefreshScheduler();
        scheduler.request();
        expect(scheduler.begin()).toBe(true);

        // Ten triggers land while the sweep runs: none may start work.
        for (let i = 0; i < 10; i++) {
            expect(scheduler.request()).toBe('coalesce');
            expect(scheduler.begin()).toBe(false);
        }

        // Completion owes exactly one debounced follow-up.
        expect(scheduler.complete()).toBe('reschedule');
        expect(scheduler.quiescent).toBe(false);

        // The follow-up absorbs later triggers and settles idle afterwards.
        expect(scheduler.request()).toBe('coalesce');
        expect(scheduler.begin()).toBe(true);
        expect(scheduler.complete()).toBe('idle');
        expect(scheduler.quiescent).toBe(true);
    });

    it('a sweep without interleaved triggers settles idle', () => {
        const scheduler = new RefreshScheduler();
        scheduler.request();
        expect(scheduler.begin()).toBe(true);
        expect(scheduler.complete()).toBe('idle');
        expect(scheduler.quiescent).toBe(true);
    });

    it('triggers during the debounce window coalesce into the armed timer', () => {
        const scheduler = new RefreshScheduler();
        scheduler.request();
        for (let i = 0; i < 9; i++) {
            expect(scheduler.request()).toBe('coalesce');
        }
        // One sweep at fire time observes the latest state of all ten.
        expect(scheduler.begin()).toBe(true);
        expect(scheduler.complete()).toBe('idle');
    });

    it('sustained storms converge to one follow-up per storm', () => {
        const scheduler = new RefreshScheduler();
        scheduler.request();
        expect(scheduler.begin()).toBe(true);
        let runs = 1;

        for (let storm = 0; storm < 3; storm++) {
            // Ten edits land while the previous sweep is still executing.
            for (let i = 0; i < 10; i++) {
                expect(scheduler.request()).toBe('coalesce');
            }
            if (scheduler.complete() === 'reschedule') {
                runs += 1;
                // A pending follow-up absorbs stragglers, then starts.
                expect(scheduler.request()).toBe('coalesce');
                expect(scheduler.begin()).toBe(true);
            }
        }
        expect(runs).toBe(4);

        // Quiescence: settle the tail run.
        while (scheduler.complete() === 'reschedule') {
            expect(scheduler.request()).toBe('coalesce');
            expect(scheduler.begin()).toBe(true);
        }
        expect(scheduler.quiescent).toBe(true);
    });

    it('cancelPending drops an armed timer and the next trigger rearms', () => {
        const scheduler = new RefreshScheduler();
        expect(scheduler.request()).toBe('arm');
        scheduler.cancelPending();
        expect(scheduler.quiescent).toBe(true);
        expect(scheduler.request()).toBe('arm');
        expect(scheduler.begin()).toBe(true);
    });

    it('phase-mismatched calls are ignored but never lose an armed timer', () => {
        const scheduler = new RefreshScheduler();
        expect(scheduler.begin()).toBe(false);
        expect(scheduler.complete()).toBe('idle');

        scheduler.request();
        expect(scheduler.complete()).toBe('idle');
        expect(scheduler.quiescent).toBe(false);
        // The armed timer survives phase-mismatched calls and still wins.
        expect(scheduler.request()).toBe('coalesce');
        expect(scheduler.begin()).toBe(true);
        expect(scheduler.complete()).toBe('idle');
        expect(scheduler.quiescent).toBe(true);
    });
});
