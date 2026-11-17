import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CalendarEntry } from "@agent/core";
import { describeRRule, expandRRule } from "./schedule-expand";
import { clip, num, readRows, str } from "./sqlite";
import type { CalendarRange, CalendarSourceResult } from "./types";

/** WorkBuddy automations / automation_runs, read-only like the session catalog. */
export async function readWorkBuddySource(range: CalendarRange, root: string): Promise<CalendarSourceResult> {
  const dbPath = join(root, "workbuddy.db");
  if (!existsSync(dbPath)) return { entries: [], groups: [] };
  const entries: CalendarEntry[] = [];
  const names = new Map<string, string>();

  for (const row of readRows(dbPath, "SELECT id, name, status, schedule_type, next_run_at, last_run_at, cwds, rrule, scheduled_at, deleted_at FROM automations")) {
    if (num(row.deleted_at) !== undefined) continue;
    const id = str(row.id);
    const name = clip(str(row.name) || id, 80);
    names.set(id, name);
    const active = str(row.status).toUpperCase() === "ACTIVE";
    const cwds = safeJsonArray(str(row.cwds));
    const base = { source: "workbuddy" as const, title: name, cwd: cwds[0] };
    if (str(row.schedule_type) === "once") {
      const at = Date.parse(str(row.scheduled_at)) || num(row.next_run_at) || num(row.last_run_at);
      if (at && at >= range.fromMs && at <= range.toMs) {
        entries.push({ ...base, id: `${id}:once`, kind: "cron", at, state: active ? "upcoming" : "paused", scheduleLabel: "一次性", recurring: false });
      }
    } else {
      const rrule = str(row.rrule);
      const anchor = Date.parse(str(row.scheduled_at)) || num(row.next_run_at);
      for (const at of expandRRule(rrule, range.fromMs, range.toMs, { anchorMs: anchor })) {
        entries.push({ ...base, id: `${id}:${at}`, kind: "cron", at, state: active ? "upcoming" : "paused", scheduleLabel: describeRRule(rrule), recurring: true });
      }
    }
    const lastRun = num(row.last_run_at);
    if (lastRun && lastRun >= range.fromMs && lastRun <= range.toMs) {
      entries.push({ ...base, id: `${id}:last`, kind: "run", at: lastRun, state: "completed" });
    }
  }

  for (const row of readRows(dbPath, "SELECT thread_id, automation_id, status, thread_title, source_cwd, result_success, created_at FROM automation_runs")) {
    const at = num(row.created_at);
    if (!at || at < range.fromMs || at > range.toMs) continue;
    const automationId = str(row.automation_id);
    const success = num(row.result_success) === 1;
    entries.push({
      id: `workbuddy:run:${str(row.thread_id)}`, kind: "run", source: "workbuddy",
      title: names.get(automationId) || automationId,
      at, state: success ? "completed" : "failed",
      detail: clip(str(row.thread_title), 200) || undefined,
      cwd: str(row.source_cwd) || undefined,
      sessionId: str(row.thread_id) || undefined,
    });
  }
  return { entries, groups: [] };
}

function safeJsonArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}