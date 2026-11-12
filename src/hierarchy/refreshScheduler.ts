// SPDX-License-Identifier: MIT
//
// Pure latest-wins refresh scheduler for the HDL Modules explorer sweeps.
//
// A sweep is expensive (one workspace-symbol query plus up to hundreds of
// sequential document-symbol round-trips), so overlapping sweeps must never
// pile up.  The state machine mirrors Lapligence's per-root analysis
// scheduler (`lapligence/src/bin/llg_ls/scheduler.rs`):
//
// * **Trailing-edge debounce** — the first trigger while idle arms ONE timer;
//   further triggers during the quiet period are absorbed by it.
// * **Latest-wins coalescing** — while a sweep is RUNNING, triggers never
//   start another one; they only mark the work dirty, and completion arms
//   exactly one debounced follow-up that observes the latest state.
//
// No `vscode` import: this module is jest-testable in plain Node (the Jest
// setup has no vscode mock).  The caller owns timers and awaits.

export type TriggerDecision = 'arm' | 'coalesce';
export type CompleteDecision = 'idle' | 'reschedule';

export class RefreshScheduler {
    private pending = false;
    private running = false;
    private dirty = false;

    /** True when no timer is pending, no sweep runs and nothing is owed. */
    get quiescent(): boolean {
        return !this.pending && !this.running && !this.dirty;
    }

    /** Record one refresh trigger ('arm' = start a debounce timer now). */
    request(): TriggerDecision {
        if (this.running) {
            // Never queue behind a running sweep; remember only that newer
            // inputs exist so the follow-up sees the latest state.
            this.dirty = true;
            return 'coalesce';
        }
        if (this.pending) {
            // The armed timer already covers this burst.
            return 'coalesce';
        }
        this.pending = true;
        return 'arm';
    }

    /**
     * The debounce timer elapsed: true when the caller won the
     * Pending→Running transition and should run exactly one sweep.
     */
    begin(): boolean {
        if (!this.pending || this.running) {
            return false;
        }
        this.pending = false;
        this.running = true;
        return true;
    }

    /** Roll back an armed timer without running (dispose/shutdown). */
    cancelPending(): void {
        this.pending = false;
    }

    /**
     * The running sweep finished: 'reschedule' when triggers arrived during
     * it (arm exactly one follow-up timer), 'idle' otherwise.
     */
    complete(): CompleteDecision {
        if (!this.running) {
            return 'idle';
        }
        this.running = false;
        if (this.dirty) {
            this.dirty = false;
            this.pending = true;
            return 'reschedule';
        }
        return 'idle';
    }
}
