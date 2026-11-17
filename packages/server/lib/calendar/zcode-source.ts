import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeCron, listCronFires, todoState, type CalendarEntry, type CalendarTodoGroup } from "@agent/core";
import { clip, num, readRows, str, timeMs } from "./sqlite";
import type { CalendarRange, CalendarSourceResult } from "./types";

const UNIT_MS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };
const UNIT_LABEL: Record<string, string> = { minute: "分钟", hour: "小时", day: "天", week: "周" };
const RECENT_SESSION_MS = 30 * 86_400_000;

/** ZCode automations (v2/tasks-index.sqlite) and session todos (cli/db/db.sqlite). */
export async function readZCodeSource(range: CalendarRange, zcodeHome: string): Promise<CalendarSourceResult> {
  const entries: CalendarEntry[] = [];
  const groups: CalendarTodoGroup[] = [];
  const indexDb = join(zcodeHome, "v2", "tasks-index.sqlite");
  const names = new Map<string, string>();

  if (existsSync(indexDb)) {
    for (const row of readRows(indexDb, "SELECT automation_id, title, cron_expr, prompt, schedule_rule, enabled, lifecycle_status, next_run_at, last_run_at, workspace_path, recurring, last_error, created_at FROM automations")) {
      const id = str(row.automation_id);
      const title = clip(str(row.title) || id, 80);
      names.set(id, title);
      const lifecycle = str(row.lifecycle_status);
      const base = {
        source: "zcode" as const, title,
        cwd: str(row.workspace_path) || undefined,
        detail: clip(str(row.prompt), 200) || undefined,
      };
      const lastRun = timeMs(row.last_run_at);
      const nextRun = timeMs(row.next_run_at);
      const createdAt = timeMs(row.created_at);
      if (lifecycle === "completed" || lifecycle === "failed") {
        const at = lastRun ?? nextRun ?? createdAt;
        if (at && at >= range.fromMs && at <= range.toMs) {
          entries.push({ ...base, id: `${id}:end`, kind: "run", at, state: lifecycle === "completed" ? "completed" : "failed", detail: lifecycle === "failed" ? clip(str(row.last_error), 200) || base.detail : base.detail });
        }
        continue;
      }
      const cronExpr = str(row.cron_expr);
      const rule = parseScheduleRule(str(row.schedule_rule));
      const scheduleLabel = cronExpr ? describeCron(cronExpr)
        : rule ? `每 ${rule.interval} ${UNIT_LABEL[rule.unit] ?? rule.unit}` : undefined;
      if (num(row.enabled) !== 1) {
        const at = nextRun ?? lastRun ?? createdAt;
        if (at && at >= range.fromMs && at <= range.toMs) entries.push({ ...base, id: `${id}:paused`, kind: "cron", at, state: "paused", scheduleLabel });
        continue;
      }
      if (num(row.recurring) === 1) {
        let fires: number[] = [];
        if (cronExpr) fires = listCronFires(cronExpr, range.fromMs, range.toMs);
        else if (rule) {
          const step = (UNIT_MS[rule.unit] ?? 0) * rule.interval;
          const anchor = rule.anchorAt ?? createdAt ?? range.fromMs;
          if (step > 0) {
            let t = anchor;
            if (t < range.fromMs) t += Math.ceil((range.fromMs - t) / step) * step;
            for (; t <= range.toMs && fires.length < 400; t += step) fires.push(t);
          }
        }
        for (const at of fires) entries.push({ ...base, id: `${id}:${at}`, kind: "cron", at, state: "upcoming", scheduleLabel, recurring: true });
      } else if (nextRun && nextRun >= range.fromMs && nextRun <= range.toMs) {
        entries.push({ ...base, id: `${id}:once`, kind: "cron", at: nextRun, state: "upcoming", scheduleLabel: scheduleLabel ?? "一次性", recurring: false });
      }
    }

    for (const row of readRows(indexDb, "SELECT run_id, automation_id, scheduled_at, outcome, session_id, error, created_at FROM automation_runs")) {
      const outcome = str(row.outcome);
      if (!outcome) continue;
      const at = timeMs(row.created_at) ?? timeMs(row.scheduled_at);
      if (!at || at < range.fromMs || at > range.toMs) continue;
      const automationId = str(row.automation_id);
      entries.push({
        id: `zcode:run:${str(row.run_id)}`, kind: "run", source: "zcode",
        title: names.get(automationId) || automationId,
        at, state: outcome === "succeeded" ? "completed" : "failed",
        detail: clip(str(row.error), 200) || undefined,
        sessionId: str(row.session_id) || undefined,
      });
    }
  }

  const cliDb = join(zcodeHome, "cli", "db", "db.sqlite");
  if (existsSync(cliDb)) {
    groups.push(...readTodoGroups(cliDb, "zcode", range, "s.time_deleted IS NULL"));
  }
  return { entries, groups };
}

function parseScheduleRule(raw: string): { unit: string; interval: number; anchorAt?: number } | null {
  try {
    const value = JSON.parse(raw) as { unit?: string; interval?: number; anchorAt?: number | string };
    if (!value?.unit || typeof value.interval !== "number" || value.interval < 1) return null;
    return { unit: value.unit, interval: value.interval, anchorAt: timeMs(value.anchorAt) };
  } catch {
    return null;
  }
}

/** Shared todo projection for zcode/opencode session databases. */
export function readTodoGroups(dbPath: string, source: "zcode" | "opencode", range: CalendarRange, sessionFilter: string): CalendarTodoGroup[] {
  const rows = readRows(dbPath,
    `SELECT t.session_id, t.content, t.status, t.position, t.time_updated, s.title, s.directory, s.time_updated AS session_updated
     FROM todo t JOIN session s ON s.id = t.session_id WHERE ${sessionFilter} ORDER BY t.session_id, t.position`);
  const bySession = new Map<string, { title: string; cwd: string; updatedAt: number; todos: CalendarEntry[]; open: boolean }>();
  for (const row of rows) {
    const sessionId = str(row.session_id);
    let bucket = bySession.get(sessionId);
    if (!bucket) {
      bucket = { title: str(row.title), cwd: str(row.directory), updatedAt: timeMs(row.session_updated) ?? 0, todos: [], open: false };
      bySession.set(sessionId, bucket);
    }
    const status = str(row.status);
    if (status !== "completed") bucket.open = true;
    bucket.todos.push({
      id: `${source}:${sessionId}:${bucket.todos.length}`, kind: "todo", source,
      title: clip(str(row.content), 120), at: 0,
      state: todoState(status, undefined, range.nowMs),
    });
  }
  const groups: CalendarTodoGroup[] = [];
  for (const [sessionId, bucket] of bySession) {
    if (!bucket.todos.length) continue;
    if (!bucket.open && bucket.updatedAt < range.nowMs - RECENT_SESSION_MS) continue;
    groups.push({
      id: `${source}:${sessionId}`, source,
      title: bucket.title || "未命名会话", cwd: bucket.cwd || undefined, updatedAt: bucket.updatedAt,
      todos: bucket.todos,
    });
  }
  return groups;
}