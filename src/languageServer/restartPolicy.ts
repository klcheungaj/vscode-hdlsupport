const RESTART_SETTING_KEYS: readonly string[] = [
    'hdlsupport.llg.path',
    'hdlsupport.llg.configPath',
    'hdlsupport.llg.logLevel',
];

/** Decides whether a configuration change requires a server restart. Restart ONLY when one of
 *  'hdlsupport.llg.path', 'hdlsupport.llg.configPath' or 'hdlsupport.llg.logLevel' changed.
 *  TOML content changes are handled by the running server. */
export function shouldRestartOnConfigChange(affectedSettingKeys: string[]): boolean {
    return affectedSettingKeys.some((key) => RESTART_SETTING_KEYS.includes(key));
}

/** The launch-relevant settings a running server was started with (or would be
 *  started with now). Mirrors what LlgClientManager passes to the server. */
export interface LaunchParamsSnapshot {
    serverPath: string;
    logLevel: string;
    /** Effective config path keyed by workspace-folder URI string. */
    configPaths: Readonly<Record<string, string>>;
}

/** True iff the new settings differ from the running server's launch parameters.
 *  Folders ADDED/REMOVED never count (the server supports workspace folders
 *  natively); only folders present in BOTH snapshots count for configPath
 *  comparison. A null applied snapshot means nothing to restart yet. */
export function launchParamsDiffer(applied: LaunchParamsSnapshot | null, current: LaunchParamsSnapshot): boolean {
    if (applied === null) {
        return false;
    }
    if (applied.serverPath !== current.serverPath || applied.logLevel !== current.logLevel) {
        return true;
    }
    for (const [folderUri, configPath] of Object.entries(current.configPaths)) {
        const appliedConfigPath = applied.configPaths[folderUri];
        if (appliedConfigPath !== undefined && appliedConfigPath !== configPath) {
            return true;
        }
    }
    return false;
}

export interface CrashRestartTrackerOptions {
    windowMs?: number;
    maxRestarts?: number;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_RESTARTS = 4;

/** Bounded automatic crash-restart bookkeeping over a sliding time window. */
export class CrashRestartTracker {
    private readonly windowMs: number;
    private readonly maxRestarts: number;
    private restartTimes: number[] = [];

    constructor(options: CrashRestartTrackerOptions = {}) {
        this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
        this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    }

    /** Record a crash/restart at time `now`; returns true when another automatic restart is allowed. */
    allowRestart(now: number): boolean {
        this.prune(now);
        if (this.restartTimes.length >= this.maxRestarts) {
            return false;
        }
        this.restartTimes.push(now);
        return true;
    }

    /** True once the limit within the window has been exhausted. */
    exhausted(now: number): boolean {
        this.prune(now);
        return this.restartTimes.length >= this.maxRestarts;
    }

    reset(): void {
        this.restartTimes = [];
    }

    private prune(now: number): void {
        const cutoff = now - this.windowMs;
        while (this.restartTimes.length > 0 && this.restartTimes[0] <= cutoff) {
            this.restartTimes.shift();
        }
    }
}
