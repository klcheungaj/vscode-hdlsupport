// SPDX-License-Identifier: MIT
//
// Pure decision logic for the inactive-region dimming feature. This file must
// stay free of `import ... from 'vscode'` so it loads (and is unit-tested) in
// plain Node - jest has no vscode mock; inactiveRegions.ts wraps these helpers
// in the thin TextEditorDecorationType controller.

/** One dimmed region as plain data: zero-based inclusive line span. */
export interface PureInactiveRange {
    start: number;
    end: number;
}

/**
 * Validates one raw wire entry (`{ startLine, endLine }` from
 * `llg/inactiveRanges`) against the document's line count. Invalid entries
 * are dropped rather than guessed at - the server owns all computation and
 * the client never widens what it received.
 */
function sanitizeEntry(entry: unknown, lineCount: number): PureInactiveRange | null {
    if (typeof entry !== 'object' || entry === null) {
        return null;
    }
    const startLine = (entry as Record<string, unknown>).startLine;
    const endLine = (entry as Record<string, unknown>).endLine;
    if (typeof startLine !== 'number' || typeof endLine !== 'number') {
        return null;
    }
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
        return null;
    }
    if (startLine < 0 || endLine < startLine || endLine >= lineCount) {
        return null;
    }
    return { start: startLine, end: endLine };
}

/**
 * Normalizes a raw `llg/inactiveRanges` response: keeps only valid entries,
 * sorts by start and merges overlapping or adjacent spans. The server already
 * guarantees sorted non-overlapping output; this stays defensive because the
 * decoration layer would render overlapping spans unpredictably.
 */
export function sanitizeInactiveRanges(raw: unknown, lineCount: number): PureInactiveRange[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const ranges: PureInactiveRange[] = [];
    for (const entry of raw) {
        const range = sanitizeEntry(entry, lineCount);
        if (range !== null) {
            ranges.push(range);
        }
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: PureInactiveRange[] = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end + 1) {
            last.end = Math.max(last.end, range.end);
            continue;
        }
        merged.push({ ...range });
    }
    return merged;
}

/** Value equality over normalized ranges (applied-vs-fetched comparison). */
export function inactiveRangesEqual(a: readonly PureInactiveRange[], b: readonly PureInactiveRange[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    return a.every((range, index) => range.start === b[index].start && range.end === b[index].end);
}

/**
 * Whether cached decoration data still describes the document's CURRENT
 * content: an entry only exists for a completed fetch, and its version must
 * equal the document version being repainted. Guards editor switches from
 * repainting stale cached ranges after the document changed since the cache
 * write (the fetch response itself is dropped by the requested-version
 * check in the controller).
 */
export function cachedRangesAreCurrent(
    appliedVersion: number | undefined,
    documentVersion: number,
): boolean {
    return appliedVersion !== undefined && appliedVersion === documentVersion;
}

/** Trailing-edge quiet period before a refetch after buffer edits. */
export const INACTIVE_REGION_DEBOUNCE_MS = 300;

export interface DebounceController {
    /** Restarts the quiet window; `fn` runs once it expires. */
    schedule(): void;
    /** Drops any pending run without executing it. */
    cancel(): void;
}

/**
 * Classic trailing-edge debounce: every schedule() call restarts the timer so
 * bursts of didChange events collapse into ONE refetch ~300ms after typing
 * stops. Plain setTimeout/clearTimeout keep this testable under jest fake
 * timers without any vscode dependency.
 */
export function createTrailingDebounce(fn: () => void, delayMs: number): DebounceController {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        schedule(): void {
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                timer = undefined;
                fn();
            }, delayMs);
        },
        cancel(): void {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
    };
}
