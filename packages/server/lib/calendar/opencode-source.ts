import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CalendarEntry } from "@agent/core";
import { expandWhen } from "./schedule-expand";
import { clip, readRows, str, timeMs } from "./sqlite";
import type { CalendarRange, CalendarSourceResult } from "./types";
import { readTodoGroups } from "./zcode-source";

/** OpenCode schedules and session todos from opencode.db (read-only). */
export async function readOpenCodeSource(range: CalendarRange, dataRoot: string): Promise<CalendarSourceResult> {
  const dbPath = join(dataRoot, "opencode.db");
  if (!existsSync(dbPath)) return { entries: [], groups: [] };
  const entries: CalendarEntry[] = [];

  for (const row of readRows(dbPath, "SELECT id, session_id, name, action, \"when\", status, next_due_at, last_fired_at, last_outcome, time_created FROM schedule")) {
    const id = str(row.id);
    const active = str(row.status) === "active";
    const when = str(row.when);
    const created = timeMs(row.time_created);
    const { fires, label, oneShot } = expandWhen(when, range.fromMs, range.toMs, { anchorMs: created });
    const base = {
      source: "opencode" as const,
      title: clip(str(row.name) || str(row.action) || id, 80),
      sessionId: str(row.session_id) || undefined,
      detail: clip(str(row.action), 200) || undefined,
      scheduleLabel: label || undefined,
    };
    for (const at of fires) {
      entries.push({ ...base, id: `${id}:${at}`, kind: "cron", at, state: active ? "upcoming" : "paused", recurring: !oneShot });
    }
    if (!fires.length) {
      const next = timeMs(row.next_due_at);
      if (next && next >= range.fromMs && next <= range.toMs) {
        entries.push({ ...base, id: `${id}:next`, kind: "cron", at: next, state: active ? "upcoming" : "paused", recurring: !oneShot });
      }
    }
    const fired = timeMs(row.last_fired_at);
    if (fired && fired >= range.fromMs && fired <= range.toMs) {
      const outcome = str(row.last_outcome).toLowerCase();
      const failed = /fail|error|timeout/.test(outcome);
      entries.push({ ...base, id: `${id}:run`, kind: "run", at: fired, state: failed ? "failed" : "completed", scheduleLabel: undefined });
    }
  }

  const groups = readTodoGroups(dbPath, "opencode", range, "s.time_archived IS NULL");
  return { entries, groups };
}