import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, resolve } from "node:path";
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

function findOnPath(name: string, platform: NodeJS.Platform): string | undefined {
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, platform === "win32" ? `${name}.exe` : name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function windowsOpenCodeCandidates(pinned?: string): string[] {
  const pathDirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter)
    .map(dir => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const roaming = process.env.APPDATA || resolve(homedir(), "AppData", "Roaming");
  const npmEntries = (directory: string) => {
    const modules = resolve(directory, basename(directory).toLowerCase() === ".bin" ? ".." : "node_modules");
    const packages = process.arch === "arm64" && process.platform === "win32"
      ? ["opencode-ai", "opencode-windows-arm64", "opencode-windows-x64-baseline", "opencode-windows-x64"]
      : ["opencode-ai", "opencode-windows-x64-baseline", "opencode-windows-x64"];
    return packages.map(name => resolve(modules, name, "bin", "opencode.exe"));
  };
  const npmPrefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  return [
    ...(pinned && /^opencode\.(?:cmd|bat)$/i.test(basename(pinned)) ? npmEntries(dirname(pinned)) : []),
    ...pathDirs.flatMap(dir => [resolve(dir, "opencode.exe"), ...npmEntries(dir)]),
    ...(npmPrefix ? npmEntries(npmPrefix) : []),
    ...npmEntries(resolve(roaming, "npm")),
  ].filter(path => path !== pinned);
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
export function resolveExternalCli(options: ResolveExternalCliOptions, platform: NodeJS.Platform = process.platform): ExternalCliResolution {
  const candidates: ExternalCliCandidate[] = [];
  const pinned = process.env[options.environmentVariable]?.trim();
  const windowsOpenCode = platform === "win32" && options.name === "opencode";

  if (pinned) {
    const executable = (!windowsOpenCode || /\.exe$/i.test(pinned)) && isExecutable(pinned);
    const version = executable ? readVersion(pinned) : undefined;
    candidates.push({
      source: "pin",
      path: pinned,
      executable: executable && (!windowsOpenCode || version !== undefined),
      version,
      error: executable ? undefined : `${options.environmentVariable} "${pinned}" is not executable`,
    });
  }

  if (windowsOpenCode && !candidates.some(candidate => candidate.executable)) {
    for (const path of new Set(windowsOpenCodeCandidates(pinned))) {
      if (!isExecutable(path)) continue;
      const version = readVersion(path);
      if (!version) continue;
      candidates.push({ source: "path", path, executable: true, version });
      break;
    }
  } else if (!windowsOpenCode) {
    const found = findOnPath(options.name, platform);
    if (found && found !== pinned) {
      candidates.push({ source: "path", path: found, executable: true, version: readVersion(found) });
    }
  }

  return selectExternalCli(candidates, {
    name: options.name,
    minimumVersion: options.minimumVersion,
  });
}
