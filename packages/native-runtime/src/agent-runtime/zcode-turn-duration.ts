import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/** ZCode's session/usage RPC only exposes session totals. Per-turn timing is
 * stored with the native user message ID, including for desktop-owned runs. */
export function readZCodeTurnDurations(
  sessionId: string,
  databasePath = join(process.env.ZCODE_STORAGE_DIR?.trim() || join(homedir(), ".zcode"), "cli", "db", "db.sqlite"),
): ReadonlyMap<string, number> {
  let database: import("node:sqlite").DatabaseSync | undefined;
  try {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    database = new DatabaseSync(databasePath, { readOnly: true });
    const durations = new Map<string, number>();
    const rows = database.prepare(`
      SELECT user_message_id, MIN(duration_ms) AS duration_ms
      FROM turn_usage
      WHERE session_id = ? AND user_message_id IS NOT NULL
      GROUP BY user_message_id
      HAVING COUNT(*) = 1 AND MIN(status) = 'completed' AND MIN(completed_at) IS NOT NULL
    `).all(sessionId);
    for (const { user_message_id, duration_ms } of rows) {
      if (typeof user_message_id === "string" && typeof duration_ms === "number"
        && Number.isFinite(duration_ms) && duration_ms >= 0) {
        durations.set(user_message_id, duration_ms);
      }
    }
    return durations;
  } catch {
    // Older or relocated native stores may be unavailable; keep history usable.
    return new Map();
  } finally {
    database?.close();
  }
}
