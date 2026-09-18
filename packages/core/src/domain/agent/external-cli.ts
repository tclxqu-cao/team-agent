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
export const CODEX_MINIMUM_VERSION = "0.153.0";

/** Extract `x.y.z` from CLI `--version` output such as `codex-cli 0.155.0`. */
export function parseVersion(output: string): string | undefined {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

/** Numeric component comparison, so 0.153.10 and 0.154.0 both clear a 0.153.2 floor. */
export function isVersionAtLeast(version: string, minimum: string): boolean {
  const components = (value: string): number[] =>
    value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const actual = components(version);
  const required = components(minimum);
  for (let index = 0; index < Math.max(actual.length, required.length); index += 1) {
    const left = actual[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/**
 * Choose the first candidate that can really be spawned and clears
 * `minimumVersion`. Unknown versions are accepted — the runtime itself reports
 * the incompatibility later, and refusing to start would be a worse default.
 */
export function selectExternalCli(
  candidates: readonly ExternalCliCandidate[],
  options: { name: string; minimumVersion?: string } ,
): ExternalCliResolution {
  const rejected: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.executable) {
      rejected.push(candidate.error ?? `${candidate.source} "${candidate.path}" is not executable`);
      continue;
    }
    if (options.minimumVersion && candidate.version && !isVersionAtLeast(candidate.version, options.minimumVersion)) {
      rejected.push(
        `${candidate.source} "${candidate.path}" reports ${candidate.version}, below ${options.minimumVersion}`,
      );
      continue;
    }
    const detail = rejected.length > 0
      ? `using ${candidate.source} "${candidate.path}"${candidate.version ? ` (${candidate.version})` : ""}; rejected: ${rejected.join("; ")}`
      : `using ${candidate.source} "${candidate.path}"${candidate.version ? ` (${candidate.version})` : ""}`;
    return { executable: candidate.path, source: candidate.source, version: candidate.version, detail };
  }
  const suffix = rejected.length > 0 ? ` Rejected: ${rejected.join("; ")}.` : "";
  const floor = options.minimumVersion ? ` >= ${options.minimumVersion}` : "";
  return {
    detail: `No usable "${options.name}"${floor} was found — install it, or pin one with AGENT_${options.name.toUpperCase()}_BIN.${suffix}`,
  };
}
