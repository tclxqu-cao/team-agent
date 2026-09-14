import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A session file held open by another client only counts as "in use" while the
 * other client is actively writing to it. Codex Desktop (ChatGPT.app) and the
 * Claude Code CLI keep file descriptors open long after their turn finishes,
 * so a pure lsof check leaves completed sessions permanently read-only.
 * By default, files whose mtime is older than this window are treated as idle
 * and become available for takeover. Codex callers disable that exemption
 * because its writer lock remains authoritative even while a thread is quiet.
 */
const DEFAULT_IDLE_AFTER_MS = 120_000;

type OpenSessionFileExecutor = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

interface OpenSessionFileOptions {
  excludePids?: Iterable<number>;
  idleAfterMs?: number | null;
  platform?: NodeJS.Platform;
  execute?: OpenSessionFileExecutor;
  nowMs?: number;
  getMtimeMs?: (file: string) => number;
}

type OpenSessionFileSelectionOptions = OpenSessionFileOptions;

export function selectOpenSessionFiles(
  stdout: string,
  root: string,
  options: OpenSessionFileSelectionOptions = {},
): Set<string> {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  const excluded = new Set(options.excludePids ?? []);
  const idleAfterMs = options.idleAfterMs === undefined
    ? DEFAULT_IDLE_AFTER_MS
    : options.idleAfterMs;
  const nowMs = options.nowMs ?? Date.now();
  const getMtimeMs = options.getMtimeMs ?? ((file: string) => statSync(file).mtimeMs);
  const result = new Set<string>();
  let currentPid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      currentPid = Number(line.slice(1));
    } else if (
      line.startsWith(`n${normalizedRoot}`)
      && (currentPid === null || !excluded.has(currentPid))
    ) {
      const file = line.slice(1);
      try {
        const mtimeMs = getMtimeMs(file);
        if (idleAfterMs !== null && nowMs - mtimeMs > idleAfterMs) continue;
      } catch {
        continue; // file vanished between lsof and stat — nothing to guard
      }
      result.add(file);
    }
  }
  return result;
}

export async function listOpenSessionFiles(
  commandName: "codex" | "claude",
  root: string,
  options: OpenSessionFileOptions = {},
): Promise<Set<string>> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return new Set();
  try {
    const execute = options.execute ?? execFileAsync as OpenSessionFileExecutor;
    const { stdout } = await execute(
      // launchd's PATH may omit /usr/sbin even when native CLIs are available.
      platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
      ["+c", "0", "-a", "-c", commandName, "-FpFn"],
      { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
    );
    return selectOpenSessionFiles(stdout, root, options);
  } catch {
    return new Set();
  }
}
