import { ReminderScheduleCalculator, isTodoTerminal, type TodoTask, type TodoReminderSchedule, type TodoExecutionSchedule, type TodoExecution, type TodoReminderOccurrence, type CalendarEntry, type CalendarRange } from "@agent/core";
import { join } from "node:path";
import { readRows } from "./sqlite";
/** Only this service's independent Todos. Never reads session plans/transcripts. */
export function readTodoCalendar(range: CalendarRange, baseDir: string, ownerId?: string): CalendarEntry[] {
  if (!ownerId) return [];
  const file = join(baseDir, ".agent-data", "agent.db");
  const tables = ["todo_tasks", "todo_reminder_schedules", "todo_reminder_occurrences", "todo_execution_schedules", "todo_executions"];
  // A single SQLite statement keeps dates, generations and execution rows in
  // one read snapshot while the scheduler commits concurrently.
  const snapshot = readRows(file, tables.map(table => `SELECT '${table}' AS collection,data FROM ${table} WHERE owner_id=?`).join(" UNION ALL "), ...tables.map(() => ownerId));
  const rows = <T extends { ownerId: string }>(table: string) => snapshot.filter(r => r.collection === table).flatMap(r => { try { const value = JSON.parse(String(r.data)) as T; return value.ownerId === ownerId ? [value] : []; } catch { return []; } });
  const tasks = rows<TodoTask>("todo_tasks"), byId = new Map(tasks.map(t => [t.id, t])), entries: CalendarEntry[] = [];
  const reminders = rows<TodoReminderSchedule>("todo_reminder_schedules"), occurrences = rows<TodoReminderOccurrence>("todo_reminder_occurrences");
  for (const t of tasks) if (t.dueAt !== undefined && t.dueAt >= range.fromMs && t.dueAt <= range.toMs && t.status !== "cancelled") {
    const reminder = reminders.find(r => r.taskId === t.id && r.enabled && r.trigger.kind === "once" && r.trigger.at === t.dueAt);
    const occurred = occurrences.some(r => r.taskId === t.id && r.scheduledAt === t.dueAt);
    entries.push({ id: `todo:${t.id}:due`, kind: reminder || occurred ? "reminder" : "due", source: "customer-agent", taskId: t.id, title: t.title, at: t.dueAt!, dueAt: t.dueAt, state: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in-progress" : t.dueAt! < range.nowMs ? "overdue" : "pending", detail: occurred ? "待办日期 · 提醒已生成" : reminder ? "待办日期 · 到点提醒" : "待办日期" });
  }
  const calc = new ReminderScheduleCalculator();
  for (const [table, kind] of [["todo_reminder_schedules", "reminder"], ["todo_execution_schedules", "cron"]] as const) for (const s of rows<TodoReminderSchedule | TodoExecutionSchedule>(table)) {
    const task = byId.get(s.taskId); if (!task || isTodoTerminal(task) || !s.enabled || s.nextFireAt === null) continue;
    if (kind === "reminder" && s.trigger.kind === "once" && s.trigger.at === task.dueAt) continue;
    let at = calc.next(s.trigger, s.timeZone, Math.max(range.fromMs - 1, s.nextFireAt - 1));
    for (let n = 0; at !== null && at <= range.toMs && n < 1000; n++) {
      entries.push({ id: `todo:${s.id}:${s.generation}:${at}`, taskId: task.id, kind, source: "customer-agent", title: task.title, at, state: "upcoming", scheduleId: s.id, scheduleRef: `agentroam:${table}:${s.id}`, scheduledAt: at, scheduleLabel: s.trigger.kind === "cron" ? `${s.trigger.expression} · ${s.timeZone}` : s.timeZone, recurring: s.trigger.kind === "cron", detail: kind === "reminder" ? "只提醒" : `自动执行 · ${(s as TodoExecutionSchedule).target.agentType}` });
      at = calc.next(s.trigger, s.timeZone, at);
    }
  }
  for (const r of rows<TodoReminderOccurrence>("todo_reminder_occurrences")) if (r.scheduledAt >= range.fromMs && r.scheduledAt <= range.toMs && byId.get(r.taskId)?.dueAt !== r.scheduledAt) entries.push({ id: `todo:reminder:${r.id}`, taskId: r.taskId, source: "customer-agent", kind: "reminder", title: byId.get(r.taskId)?.title ?? "待办提醒", at: r.scheduledAt, state: "completed", scheduleId: r.scheduleId, detail: "已生成提醒" });
  for (const e of rows<TodoExecution>("todo_executions")) if (e.scheduledAt >= range.fromMs && e.scheduledAt <= range.toMs) entries.push({ id: `todo:execution:${e.id}`, taskId: e.taskId, source: "customer-agent", kind: "run", title: byId.get(e.taskId)?.title ?? "定时待办", at: e.scheduledAt, scheduledAt: e.scheduledAt, scheduleId: e.scheduleId, executedAt: e.startedAt, state: ({ succeeded: "completed", running: "in-progress", waiting_for_human: "in-progress", queued: "upcoming", missed: "overdue", skipped: "paused", cancelled: "paused", needs_review: "failed", failed: "failed" } as const)[e.status], detail: e.summary ?? e.error ?? ({ queued: "等待执行", running: "正在执行", waiting_for_human: "等待你的确认", succeeded: "执行完成", failed: "执行失败", cancelled: "已取消", missed: "错过执行时间", skipped: "上一轮尚未结束，已跳过本次", needs_review: "运行结束，业务结果需要核实" })[e.status], sessionId: e.sessionId });
  return entries;
}
