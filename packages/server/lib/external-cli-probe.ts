import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import {
  parseVersion,
  selectExternalCli,
  type ExternalCliCandidate,
  type ExternalCliResolution,
} from "@agent/core";

/**
 * Infrastructure adapter: turn the process environment into
 * {@link ExternalCliCandidate} facts so the domain policy can decide.
 *
 * Probing is synchronous on purpose — the broker host is built lazily inside a
 * synchronous factory, and a single `access` + `--version` per CLI is cheap
 * enough to run once when this process becomes the host.
 */

const VERSION_TIMEOUT_MS = 5_000;

function isExecutable(path: string): boolean {
  if (!path.trim()) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function readVersion(path: string): string | undefined {
  try {
    return parseVersion(
      execFileSync(path, ["--version"], {
        encoding: "utf8",
        timeout: VERSION_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    return undefined;
  }
}

export interface ResolveExternalCliOptions {
  /** CLI name — used for `$PATH` lookup and for diagnostics. */
  name: string;
  /** Environment variable holding an injected pin, e.g. `AGENT_CODEX_BIN`. */
  environmentVariable: string;
  /** Compatibility floor; candidates below it are rejected. */
  minimumVersion?: string;
}

/** Resolve which external CLI this process should spawn, if any. */
export function resolveExternalCli(options: ResolveExternalCliOptions): ExternalCliResolution {
  const candidates: ExternalCliCandidate[] = [];
  const pinned = process.env[options.environmentVariable]?.trim();

  if (pinned) {
    const executable = isExecutable(pinned);
    candidates.push({
      source: "pin",
      path: pinned,
      executable,
      version: executable ? readVersion(pinned) : undefined,
      error: executable ? undefined : `${options.environmentVariable} "${pinned}" is not executable`,
    });
  }

  const found = findOnPath(options.name);
  if (found && found !== pinned) {
    candidates.push({ source: "path", path: found, executable: true, version: readVersion(found) });
  }

  return selectExternalCli(candidates, {
    name: options.name,
    minimumVersion: options.minimumVersion,
  });
}
