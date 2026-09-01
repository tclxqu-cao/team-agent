import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A session file held open by another client only counts as "in use" while the
 * other client is actively writing to it. Codex Desktop (ChatGPT.app) and the
 * Claude Code CLI keep file descriptors open long after their turn finishes,
 * so a pure lsof check leaves completed sessions permanently read-only.
 * Files whose mtime is older than this window are treated as idle and become
 * available for takeover. 2 minutes comfortably covers the gaps between
 * item writes during an active turn (each tool call / message item flushes).
 */
const DEFAULT_IDLE_AFTER_MS = 120_000;

export async function listOpenSessionFiles(
  commandName: "codex" | "claude",
  root: string,
  options: { excludePids?: Iterable<number>; idleAfterMs?: number } = {},
): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["+c", "0", "-a", "-c", commandName, "-FpFn"],
      { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
    );
    const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
    const excluded = new Set(options.excludePids ?? []);
    const idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
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
        // Held open but quiet → the owning client is idle, not actively using
        // the session. Allow takeover instead of keeping it read-only forever.
        try {
          const { mtimeMs } = statSync(file);
          if (Date.now() - mtimeMs > idleAfterMs) continue;
        } catch {
          continue; // file vanished between lsof and stat — nothing to guard
        }
        result.add(file);
      }
    }
    return result;
  } catch {
    return new Set();
  }
}
