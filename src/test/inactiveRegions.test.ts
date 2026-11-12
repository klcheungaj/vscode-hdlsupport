// SPDX-License-Identifier: MIT
//
// Pure unit tests for the inactive-region client seam: wire-response
// sanitization, applied-vs-fetched equality, the trailing-edge refetch
// debounce and the stale-repaint cache guard. The vscode-dependent controller
// lives behind these helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    cachedRangesAreCurrent,
    createTrailingDebounce,
    INACTIVE_REGION_DEBOUNCE_MS,
    inactiveRangesEqual,
    sanitizeInactiveRanges,
} from '../clientFeatures/inactiveRegionsPure';

describe('sanitizeInactiveRanges', () => {
    it('passes valid ranges through as plain data', () => {
        expect(
            sanitizeInactiveRanges(
                [
                    { startLine: 3, endLine: 5 },
                    { startLine: 8, endLine: 9 },
                ],
                10,
            ),
        ).toEqual([
            { start: 3, end: 5 },
            { start: 8, end: 9 },
        ]);
    });

    it('drops malformed entries instead of guessing', () => {
        expect(
            sanitizeInactiveRanges(
                [
                    null,
                    'nope',
                    42,
                    {},
                    { startLine: -1, endLine: 2 },
                    { startLine: 4, endLine: 2 },
                    { startLine: 8, endLine: 12 },
                    { startLine: 1.5, endLine: 2 },
                    { startLine: 2 },
                ],
                10,
            ),
        ).toEqual([]);
    });

    it('sorts by start and merges overlapping spans', () => {
        expect(
            sanitizeInactiveRanges(
                [
                    { startLine: 5, endLine: 7 },
                    { startLine: 0, endLine: 5 },
                    { startLine: 6, endLine: 9 },
                ],
                20,
            ),
        ).toEqual([{ start: 0, end: 9 }]);
    });

    it('merges adjacent (touching) spans into one contiguous block', () => {
        expect(
            sanitizeInactiveRanges(
                [
                    { startLine: 0, endLine: 1 },
                    { startLine: 2, endLine: 4 },
                ],
                10,
            ),
        ).toEqual([{ start: 0, end: 4 }]);
    });

    it('keeps spans separated by active lines distinct', () => {
        expect(
            sanitizeInactiveRanges(
                [
                    { startLine: 0, endLine: 2 },
                    { startLine: 4, endLine: 6 },
                ],
                10,
            ),
        ).toEqual([
            { start: 0, end: 2 },
            { start: 4, end: 6 },
        ]);
    });

    it('returns empty output for non-array payloads', () => {
        expect(sanitizeInactiveRanges(undefined, 10)).toEqual([]);
        expect(sanitizeInactiveRanges({ ranges: [] }, 10)).toEqual([]);
    });
});

describe('inactiveRangesEqual', () => {
    it('compares by value', () => {
        const a = [
            { start: 1, end: 2 },
            { start: 4, end: 5 },
        ];
        expect(inactiveRangesEqual(a, [{ start: 1, end: 2 }, { start: 4, end: 5 }])).toBe(true);
        expect(inactiveRangesEqual(a, [{ start: 1, end: 2 }])).toBe(false);
        expect(inactiveRangesEqual(a, [{ start: 1, end: 2 }, { start: 4, end: 6 }])).toBe(false);
        expect(inactiveRangesEqual([], [])).toBe(true);
    });
});

describe('cachedRangesAreCurrent', () => {
    it('accepts only an exact version match', () => {
        expect(cachedRangesAreCurrent(7, 7)).toBe(true);
    });

    it('rejects stale cache entries after the document changed', () => {
        expect(cachedRangesAreCurrent(7, 8)).toBe(false);
    });

    it('rejects a missing applied version (never fetched)', () => {
        expect(cachedRangesAreCurrent(undefined, 3)).toBe(false);
    });
});

describe('createTrailingDebounce', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fires once after the quiet period expires', () => {
        const fn = vi.fn();
        const debounce = createTrailingDebounce(fn, INACTIVE_REGION_DEBOUNCE_MS);
        debounce.schedule();
        vi.advanceTimersByTime(INACTIVE_REGION_DEBOUNCE_MS - 1);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('collapses bursts into one trailing run', () => {
        const fn = vi.fn();
        const debounce = createTrailingDebounce(fn, INACTIVE_REGION_DEBOUNCE_MS);
        for (let burst = 0; burst < 5; burst++) {
            debounce.schedule();
            vi.advanceTimersByTime(INACTIVE_REGION_DEBOUNCE_MS - 50);
        }
        vi.advanceTimersByTime(INACTIVE_REGION_DEBOUNCE_MS);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('cancel drops the pending run without executing it', () => {
        const fn = vi.fn();
        const debounce = createTrailingDebounce(fn, INACTIVE_REGION_DEBOUNCE_MS);
        debounce.schedule();
        debounce.cancel();
        vi.advanceTimersByTime(INACTIVE_REGION_DEBOUNCE_MS * 2);
        expect(fn).not.toHaveBeenCalled();
        // A later schedule still works after a cancel.
        debounce.schedule();
        vi.advanceTimersByTime(INACTIVE_REGION_DEBOUNCE_MS);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
