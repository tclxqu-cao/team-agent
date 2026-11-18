import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeCron, listCronFires, parseIntervalMs,
  type CalendarEntry, type CalendarRange, type CalendarSourceResult, type CalendarTodoGroup, type CronTask,
} from "@agent/core";
import { clip } from "./sqlite";

/** AgentRoam scheduled task definitions; session plans are deliberately excluded. */
export async function readCustomerAgentSource(
  range: CalendarRange,
  baseDir: string,
  projectRoots: string[],
): Promise<CalendarSourceResult> {
  const roots = [...new Set([baseDir, ...projectRoots])];
  const entries: CalendarEntry[] = [];
  const groups: CalendarTodoGroup[] = [];
  const sessionTitles = new Map<string, { title: string; updated: number }>();

  const tasks = new Map<string, CronTask>();
  for (const root of roots) {
    const file = join(root, ".agents", "scheduled_tasks.json");
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { tasks?: CronTask[] };
      for (const task of parsed.tasks ?? []) if (task?.id && !tasks.has(task.id)) tasks.set(task.id, task);
    } catch { /* corrupt task file must not sink the whole source */ }
  }

  for (const task of tasks.values()) {
    const title = clip(task.label || task.prompt || task.id, 80);
    const scheduleLabel = describeCron(task.cron);
    const session = task.sessionId ? sessionTitles.get(task.sessionId) : undefined;
    const base = {
      source: "customer-agent" as const, title, scheduleLabel, scheduleId: task.id,
      sessionId: task.sessionId, sessionTitle: session?.title || undefined,
      detail: clip(task.prompt || "", 200), recurring: task.recurring,
    };
    const intervalMs = parseIntervalMs(task.cron);
    if (!task.enabled) {
      const at = task.nextFireAt ?? task.lastFiredAt ?? task.createdAt;
      if (at >= range.fromMs && at <= range.toMs) entries.push({ ...base, id: `${task.id}:paused`, kind: "cron", at, state: "paused" });
    } else if (task.recurring) {
      const anchorMs = intervalMs !== null && task.nextFireAt ? task.nextFireAt - intervalMs : task.createdAt;
      for (const at of listCronFires(task.cron, range.fromMs, range.toMs, { anchorMs })) {
        entries.push({ ...base, id: `${task.id}:${at}`, kind: "cron", at, state: "upcoming" });
      }
    } else if (task.nextFireAt && task.nextFireAt >= range.fromMs && task.nextFireAt <= range.toMs) {
      entries.push({ ...base, id: `${task.id}:once`, kind: "cron", at: task.nextFireAt, state: "upcoming" });
    }
    if (task.lastFiredAt && task.lastFiredAt >= range.fromMs && task.lastFiredAt <= range.toMs) {
      entries.push({ ...base, id: `${task.id}:run:${task.lastFiredAt}`, kind: "run", at: task.lastFiredAt, state: "completed", scheduleLabel: undefined });
    }
  }

  return { entries, groups };
}