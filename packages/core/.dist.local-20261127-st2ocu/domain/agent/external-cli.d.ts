/**
 * Domain policy: how an external agent CLI is chosen and reported.
 *
 * Kept pure — no filesystem access, no process spawning. Infrastructure
 * adapters probe the candidates and hand the *facts* in; this module only
 * decides. That keeps the rule testable without a real machine:
 *
 *   1. a usable injected pin wins,
 *   2. otherwise a `$PATH` install that clears the compatibility floor wins,
 *   3. otherwise there is no usable CLI — never silently return a path that
 *      cannot be spawned ("latest /opt/homebrew/...").
 */
export type ExternalCliSource = "pin" | "path";
/** Observed facts about one candidate CLI. */
export interface ExternalCliCandidate {
    source: ExternalCliSource;
    path: string;
    /** Whether the process can actually execute this path. */
    executable: boolean;
    /** Version reported by the binary, when the probe could read one. */
    version?: string;
    /** Why this candidate is unusable, when it is. */
    error?: string;
}
export interface ExternalCliResolution {
    /** Path to spawn, or `undefined` when no candidate is usable. */
    executable?: string;
    source?: ExternalCliSource;
    version?: string;
    /** Human-readable explanation — safe to surface in logs and the UI. */
    detail: string;
}
/** Compatibility floor for the Codex CLI. Older builds cannot serve `app-server`. */
export declare const CODEX_MINIMUM_VERSION = "0.153.0";
/** Extract `x.y.z` from CLI `--version` output such as `codex-cli 0.155.0`. */
export declare function parseVersion(output: string): string | undefined;
/** Numeric component comparison, so 0.153.10 and 0.154.0 both clear a 0.153.2 floor. */
export declare function isVersionAtLeast(version: string, minimum: string): boolean;
/**
 * Choose the first candidate that can really be spawned and clears
 * `minimumVersion`. Unknown versions are accepted — the runtime itself reports
 * the incompatibility later, and refusing to start would be a worse default.
 */
export declare function selectExternalCli(candidates: readonly ExternalCliCandidate[], options: {
    name: string;
    minimumVersion?: string;
}): ExternalCliResolution;
//# sourceMappingURL=external-cli.d.ts.map