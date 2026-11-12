import { describe, expect, it } from 'vitest';
import {
    CrashRestartTracker,
    LaunchParamsSnapshot,
    launchParamsDiffer,
    shouldRestartOnConfigChange,
} from '../../languageServer/restartPolicy';

const ROOT = '/ws/root';
const EXTRA = '/ws/extra';
const GONE = '/ws/gone';
const ROOT_CONFIG = `${ROOT}/llg.toml`;

function snapshot(overrides: Partial<LaunchParamsSnapshot> = {}): LaunchParamsSnapshot {
    return {
        serverPath: '/ext/server/linux-x64/llg_ls',
        logLevel: 'warn',
        configPaths: { [ROOT]: ROOT_CONFIG },
        ...overrides,
    };
}

describe('shouldRestartOnConfigChange', () => {
    it.each(['hdlsupport.llg.path', 'hdlsupport.llg.configPath', 'hdlsupport.llg.logLevel'])(
        'requests a restart when %s changes',
        (key) => {
            expect(shouldRestartOnConfigChange([key])).toBe(true);
        },
    );

    it('requests a restart when a restart key appears among unrelated keys', () => {
        expect(
            shouldRestartOnConfigChange(['hdlsupport.verilog.linting.linter', 'hdlsupport.llg.logLevel']),
        ).toBe(true);
    });

    it('ignores unrelated settings', () => {
        expect(shouldRestartOnConfigChange(['hdlsupport.verilog.indexer', 'workbench.colorTheme'])).toBe(false);
    });

    it('ignores an empty change list', () => {
        expect(shouldRestartOnConfigChange([])).toBe(false);
    });
});

describe('launchParamsDiffer', () => {
    it('reports no difference for identical snapshots', () => {
        expect(launchParamsDiffer(snapshot(), snapshot())).toBe(false);
    });

    it('reports a difference when the resolved server path changes', () => {
        const current = snapshot({ serverPath: '/usr/local/bin/llg' });
        expect(launchParamsDiffer(snapshot(), current)).toBe(true);
    });

    it('reports a difference when the log level changes', () => {
        const current = snapshot({ logLevel: 'debug' });
        expect(launchParamsDiffer(snapshot(), current)).toBe(true);
    });

    it('reports a difference when a shared folder changes its effective config path', () => {
        const current = snapshot({ configPaths: { [ROOT]: `${ROOT}/other.toml` } });
        expect(launchParamsDiffer(snapshot(), current)).toBe(true);
    });

    it('ignores folders that were added since launch', () => {
        const current = snapshot({
            configPaths: { [ROOT]: ROOT_CONFIG, [EXTRA]: `${EXTRA}/llg.toml` },
        });
        expect(launchParamsDiffer(snapshot(), current)).toBe(false);
    });

    it('ignores folders that were removed since launch', () => {
        const applied = snapshot({
            configPaths: { [ROOT]: ROOT_CONFIG, [GONE]: `${GONE}/llg.toml` },
        });
        expect(launchParamsDiffer(applied, snapshot())).toBe(false);
    });

    it('reports no difference for empty config maps on both sides', () => {
        const empty = snapshot({ configPaths: {} });
        expect(launchParamsDiffer(empty, empty)).toBe(false);
    });

    it('never requests a restart before the first successful start (applied=null)', () => {
        expect(launchParamsDiffer(null, snapshot())).toBe(false);
    });
});

describe('CrashRestartTracker', () => {
    it('allows up to maxRestarts within the window then exhausts', () => {
        const tracker = new CrashRestartTracker({ windowMs: 60_000, maxRestarts: 2 });
        expect(tracker.allowRestart(0)).toBe(true);
        expect(tracker.allowRestart(1_000)).toBe(true);
        expect(tracker.allowRestart(2_000)).toBe(false);
        expect(tracker.exhausted(2_000)).toBe(true);
    });

    it('uses the documented defaults (4 restarts per 60 seconds)', () => {
        const tracker = new CrashRestartTracker();
        const base = 1_000_000;
        for (let i = 0; i < 4; i++) {
            expect(tracker.allowRestart(base + i)).toBe(true);
        }
        expect(tracker.allowRestart(base + 5)).toBe(false);
        expect(tracker.exhausted(base + 6)).toBe(true);
    });

    it('reset restores the restart allowance', () => {
        const tracker = new CrashRestartTracker({ windowMs: 60_000, maxRestarts: 1 });
        expect(tracker.allowRestart(0)).toBe(true);
        expect(tracker.allowRestart(1)).toBe(false);
        tracker.reset();
        expect(tracker.exhausted(2)).toBe(false);
        expect(tracker.allowRestart(3)).toBe(true);
    });

    it('expires crashes that fall outside the window', () => {
        const tracker = new CrashRestartTracker({ windowMs: 1_000, maxRestarts: 1 });
        expect(tracker.allowRestart(0)).toBe(true);
        expect(tracker.exhausted(999)).toBe(true);
        expect(tracker.exhausted(1_000)).toBe(false);
        expect(tracker.allowRestart(1_000)).toBe(true);
    });
});
