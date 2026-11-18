import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeCron, listCronFires, type CalendarEntry, type CalendarRange, type CalendarSourceResult, type CalendarTodoGroup } from "@agent/core";
import { clip, num, readRows, str, timeMs } from "./sqlite";

const UNIT_MS: Record<string, number> = { minute: 60_000, hourly: 3_600_000, hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000 };
const UNIT_LABEL: Record<string, string> = { minute: "分钟", hourly: "小时", hour: "小时", day: "天", week: "周" };
const RECENT_SESSION_MS = 30 * 86_400_000;

/** ZCode automations (v2/tasks-index.sqlite) and session todos (cli/db/db.sqlite). */
export async function readZCodeSource(range: CalendarRange, zcodeHome: string): Promise<CalendarSourceResult> {
  const entries: CalendarEntry[] = [];
  const groups: CalendarTodoGroup[] = [];
  const indexDb = join(zcodeHome, "v2", "tasks-index.sqlite");
  const names = new Map<string, string>();

  if (existsSync(indexDb)) {
    const runs = readRows(indexDb, "SELECT run_id, automation_id, scheduled_at, outcome, session_id, error, created_at FROM automation_runs");
    const recorded = new Set(runs.map(row => str(row.automation_id)));
    for (const row of readRows(indexDb, "SELECT automation_id, title, cron_expr, prompt, schedule_rule, enabled, lifecycle_status, next_run_at, last_run_at, workspace_path, recurring, last_error, created_at FROM automations")) {
      const id = str(row.automation_id);
      const title = clip(str(row.title) || id, 80);
      names.set(id, title);
      const lifecycle = str(row.lifecycle_status);
      const base = {
        source: "zcode" as const, title, scheduleId: id,
        cwd: str(row.workspace_path) || undefined,
        detail: clip(str(row.prompt), 200) || undefined,
      };
      const lastRun = timeMs(row.last_run_at);
      const nextRun = timeMs(row.next_run_at);
      const createdAt = timeMs(row.created_at);
      if (lifecycle === "completed" || lifecycle === "failed") {
        const at = lastRun ?? nextRun ?? createdAt;
        if (!recorded.has(id) && at && at >= range.fromMs && at <= range.toMs) {
          entries.push({ ...base, id: `${id}:end`, kind: "run", at, state: lifecycle === "completed" ? "completed" : "failed", detail: lifecycle === "failed" ? clip(str(row.last_error), 200) || base.detail : base.detail });
        }
        continue;
      }
      const cronExpr = str(row.cron_expr);
      const rule = parseScheduleRule(str(row.schedule_rule));
      const scheduleLabel = rule ? `每 ${rule.interval} ${UNIT_LABEL[rule.unit] ?? rule.unit}`
        : cronExpr ? describeCron(cronExpr) : undefined;
      if (num(row.enabled) !== 1) {
        const at = nextRun ?? lastRun ?? createdAt;
        if (at && at >= range.fromMs && at <= range.toMs) entries.push({ ...base, id: `${id}:paused`, kind: "cron", at, state: "paused", scheduleLabel });
        continue;
      }
      if (num(row.recurring) === 1) {
        let fires: number[] = [];
        if (rule && UNIT_MS[rule.unit]) {
          const step = UNIT_MS[rule.unit]! * rule.interval;
          const anchor = nextRun ?? rule.anchorAt ?? createdAt ?? range.fromMs;
          if (step > 0) {
            let t = anchor + Math.ceil((range.fromMs - anchor) / step) * step;
            for (; t <= range.toMs && fires.length < 400; t += step) fires.push(t);
          }
        } else if (cronExpr) fires = listCronFires(cronExpr, Math.max(range.fromMs, createdAt ?? range.fromMs), range.toMs);
        for (const at of fires.filter(at => at >= (createdAt ?? range.fromMs))) entries.push({ ...base, id: `${id}:${at}`, kind: "cron", at, scheduledAt: at, state: "upcoming", scheduleLabel, recurring: true });
      } else if (nextRun && nextRun >= range.fromMs && nextRun <= range.toMs) {
        entries.push({ ...base, id: `${id}:once`, kind: "cron", at: nextRun, scheduledAt: nextRun, state: "upcoming", scheduleLabel: scheduleLabel ?? "一次性", recurring: false });
      }
    }

    for (const row of runs) {
      const outcome = str(row.outcome);
      if (!["succeeded", "failed", "running"].includes(outcome)) continue;
      const scheduledAt = timeMs(row.scheduled_at);
      const executedAt = timeMs(row.created_at);
      const at = scheduledAt ?? executedAt;
      if (!at || at < range.fromMs || at > range.toMs) continue;
      const automationId = str(row.automation_id);
      if (!names.has(automationId)) continue;
      entries.push({
        id: `zcode:run:${str(row.run_id)}`, kind: "run", source: "zcode", scheduleId: automationId, scheduledAt, executedAt,
        title: names.get(automationId)!,
        at, state: outcome === "succeeded" ? "completed" : outcome === "running" ? "in-progress" : "failed",
        detail: clip(str(row.error), 200) || undefined,
        sessionId: str(row.session_id) || undefined,
      });
    }
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
