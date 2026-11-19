import { existsSync } from "node:fs";
import { join } from "node:path";
import { expandWhen, type CalendarEntry, type CalendarRange, type CalendarSourceResult } from "@agent/core";
import { clip, readRows, str, timeMs } from "./sqlite";

/** OpenCode automation dates from opencode.db (read-only). */
export async function readOpenCodeSource(range: CalendarRange, dataRoot: string): Promise<CalendarSourceResult> {
  const dbPath = join(dataRoot, "opencode.db");
  if (!existsSync(dbPath)) return { entries: [], groups: [] };
  const tables = readRows(dbPath, "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('automation', 'schedule')");
  if (tables.some(table => table.name === "automation")) {
    return { entries: readAutomations(dbPath, range), groups: [] };
  }
  if (!tables.some(table => table.name === "schedule")) return { entries: [], groups: [] };
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

  return { entries, groups: [] };
}

function readAutomations(dbPath: string, range: CalendarRange): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  const inRange = (at: number | undefined): at is number =>
    at !== undefined && at >= range.fromMs && at <= range.toMs;
  const rows = readRows(dbPath, "SELECT id, session_id, directory, name, trigger, status, next_due_at, last_run_at, last_outcome FROM automation");
  for (const row of rows) {
    const id = str(row.id);
    const next = timeMs(row.next_due_at);
    const last = timeMs(row.last_run_at);
    const status = str(row.status);
    const base = {
      source: "opencode" as const,
      scheduleId: id,
      title: clip(str(row.name) || id, 80),
      sessionId: str(row.session_id) || undefined,
      cwd: str(row.directory) || undefined,
    };
    if (inRange(next) && (status === "active" || status === "paused")) {
      let trigger: { type?: string; cron?: string; every?: string } | null = null;
      try { trigger = JSON.parse(str(row.trigger)); } catch { /* The stored next date is still usable. */ }
      entries.push({
        ...base, id: `${id}:${next}`, kind: "cron", at: next, scheduledAt: next,
        state: status === "active" ? "upcoming" : "paused",
        recurring: trigger?.type === "cron" || trigger?.type === "every",
        scheduleLabel: str(trigger?.cron) || str(trigger?.every) || undefined,
      });
    }
    if (inRange(last)) {
      const outcome = str(row.last_outcome);
      const state = outcome === "failed" ? "failed"
        : outcome === "skipped" || outcome === "disabled" || outcome === "expired" ? "paused" : "completed";
      entries.push({ ...base, id: `${id}:run:${last}`, kind: "run", at: last, executedAt: last, state });
    }
  }
  return entries;
}
