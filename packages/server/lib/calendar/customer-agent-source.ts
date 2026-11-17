import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeCron, listCronFires, parseIntervalMs, todoState,
  type CalendarEntry, type CalendarTodoGroup, type CronTask, type TodoItem,
} from "@agent/core";
import { clip, num, readRows, str } from "./sqlite";
import type { CalendarRange, CalendarSourceResult } from "./types";

/** AgentRoam's own cron tasks (.agents/scheduled_tasks.json) and todos
 * (latest todo_update event per session in .agent-data/agent.db). */
export async function readCustomerAgentSource(
  range: CalendarRange,
  baseDir: string,
  projectRoots: string[],
): Promise<CalendarSourceResult> {
  const roots = [...new Set([baseDir, ...projectRoots])];
  const entries: CalendarEntry[] = [];
  const groups: CalendarTodoGroup[] = [];
  const sessionTitles = new Map<string, { title: string; updated: number }>();
  const latestTodos = new Map<string, { todos: TodoItem[]; timestamp: number }>();

  for (const root of roots) {
    const dbPath = join(root, ".agent-data", "agent.db");
    if (!existsSync(dbPath)) continue;
    for (const row of readRows(dbPath, "SELECT id, title, updated FROM sessions")) {
      const id = str(row.id);
      const updated = Date.parse(str(row.updated));
      if (id && !sessionTitles.has(id)) sessionTitles.set(id, { title: str(row.title), updated: Number.isFinite(updated) ? updated : 0 });
    }
    for (const row of readRows(dbPath, "SELECT session_id, data, timestamp FROM events WHERE type = 'todo_update' ORDER BY id ASC")) {
      const sessionId = str(row.session_id);
      if (!sessionId) continue;
      try {
        const event = JSON.parse(str(row.data)) as { todos?: TodoItem[] };
        if (Array.isArray(event.todos)) latestTodos.set(sessionId, { todos: event.todos, timestamp: num(row.timestamp) ?? 0 });
      } catch { /* a live writer may leave a partial row */ }
    }
  }

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
      source: "customer-agent" as const, title, scheduleLabel,
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

  for (const [sessionId, { todos, timestamp }] of latestTodos) {
    if (!todos.length) continue;
    const session = sessionTitles.get(sessionId);
    const mapped: CalendarEntry[] = todos.map(todo => ({
      id: `customer-agent:${sessionId}:${todo.id}`,
      kind: "todo", source: "customer-agent",
      title: clip(todo.title || todo.id, 120),
      at: todo.dueAt ?? 0,
      state: todoState(todo.status, todo.dueAt, range.nowMs),
      dueAt: todo.dueAt,
      sessionId, sessionTitle: session?.title || undefined,
      detail: todo.agentName ? `@${todo.agentName}` : undefined,
    }));
    const dated = mapped.filter(todo => todo.dueAt !== undefined && todo.at >= range.fromMs && todo.at <= range.toMs);
    entries.push(...dated);
    const undated = mapped.filter(todo => todo.dueAt === undefined);
    if (undated.length) {
      groups.push({
        id: `customer-agent:${sessionId}`, source: "customer-agent",
        title: session?.title || "未命名会话", updatedAt: session?.updated || timestamp,
        todos: undated,
      });
    }
  }

  return { entries, groups };
}