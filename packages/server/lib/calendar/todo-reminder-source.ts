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
  const executionSchedules = rows<TodoExecutionSchedule>("todo_execution_schedules");
  const executions = rows<TodoExecution>("todo_executions");
  for (const t of tasks) if (t.dueAt !== undefined && t.dueAt >= range.fromMs && t.dueAt <= range.toMs && t.status !== "cancelled") {
    const reminder = reminders.find(r => r.taskId === t.id && r.enabled && r.trigger.kind === "once" && r.trigger.at === t.dueAt);
    const occurred = occurrences.some(r => r.taskId === t.id && r.scheduledAt === t.dueAt);
    const paused = !isTodoTerminal(t) && executionSchedules.find(s => s.taskId === t.id && !s.enabled);
    entries.push({ id: `todo:${t.id}:due`, kind: reminder || occurred ? "reminder" : "due", source: "customer-agent", taskId: t.id, title: t.title, at: t.dueAt!, dueAt: t.dueAt, state: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in-progress" : t.dueAt! < range.nowMs ? "overdue" : "pending", detail: occurred ? "待办日期 · 提醒已生成" : reminder ? "待办日期 · 到点提醒" : "待办日期", ...(paused ? { scheduleRef: `agentroam:todo_execution_schedules:${paused.id}` } : {}) });
  }
  const calc = new ReminderScheduleCalculator();
  for (const [schedules, table, kind] of [[reminders, "todo_reminder_schedules", "reminder"], [executionSchedules, "todo_execution_schedules", "cron"]] as const) for (const s of schedules) {
    const task = byId.get(s.taskId); if (!task || isTodoTerminal(task) || !s.enabled || s.nextFireAt === null) continue;
    if (kind === "reminder" && s.trigger.kind === "once" && s.trigger.at === task.dueAt) continue;
    let at = calc.next(s.trigger, s.timeZone, Math.max(range.fromMs - 1, s.nextFireAt - 1));
    for (let n = 0; at !== null && at <= range.toMs && n < 1000; n++) {
      entries.push({
        id: `todo:${s.id}:${s.generation}:${at}`, taskId: task.id, kind, source: "customer-agent",
        executionAgentType: "target" in s ? s.target.agentType : undefined,
        title: task.title, at, state: "upcoming", scheduleId: s.id, scheduleRef: `agentroam:${table}:${s.id}`,
        scheduledAt: at, scheduleLabel: s.trigger.kind === "cron" ? `${s.trigger.expression} · ${s.timeZone}` : s.timeZone,
        recurring: s.trigger.kind === "cron", detail: kind === "reminder" ? "只提醒" : "自动执行",
      });
      at = calc.next(s.trigger, s.timeZone, at);
    }
  }
  // Manual completion disables the trigger. Its original one-time date is
  // still useful when no execution or deadline card can represent the Todo.
  for (const schedule of executionSchedules) {
    const task = byId.get(schedule.taskId);
    if (task?.status !== "completed" || schedule.trigger.kind !== "once") continue;
    const at = schedule.trigger.at;
    if (at < range.fromMs || at > range.toMs || task.dueAt === at) continue;
    if (executions.some(execution => execution.scheduleId === schedule.id && execution.scheduledAt === at && execution.status === "succeeded")) continue;
    entries.push({
      id: `todo:${schedule.id}:completed`, taskId: task.id, source: "customer-agent",
      kind: "cron", title: task.title, at, scheduleId: schedule.id, state: "completed",
      executionAgentType: schedule.target.agentType,
    });
  }
  for (const r of rows<TodoReminderOccurrence>("todo_reminder_occurrences")) if (r.scheduledAt >= range.fromMs && r.scheduledAt <= range.toMs && byId.get(r.taskId)?.dueAt !== r.scheduledAt) entries.push({ id: `todo:reminder:${r.id}`, taskId: r.taskId, source: "customer-agent", kind: "reminder", title: byId.get(r.taskId)?.title ?? "待办提醒", at: r.scheduledAt, state: "completed", scheduleId: r.scheduleId, detail: "已生成提醒" });
  for (const execution of executions) {
    if (execution.scheduledAt < range.fromMs || execution.scheduledAt > range.toMs) continue;
    entries.push({
      id: `todo:execution:${execution.id}`, taskId: execution.taskId, source: "customer-agent", kind: "run",
      executionAgentType: execution.target.agentType,
      title: byId.get(execution.taskId)?.title ?? "定时待办", at: execution.scheduledAt,
      scheduledAt: execution.scheduledAt, scheduleId: execution.scheduleId, executedAt: execution.startedAt,
      state: ({ succeeded: "completed", running: "in-progress", waiting_for_human: "in-progress", queued: "upcoming", missed: "overdue", skipped: "paused", cancelled: "paused", needs_review: "failed", failed: "failed" } as const)[execution.status],
      detail: execution.summary ?? execution.error ?? ({ queued: "等待执行", running: "正在执行", waiting_for_human: "等待你的确认", succeeded: "执行完成", failed: "执行失败", cancelled: "已取消", missed: "错过执行时间", skipped: "上一轮尚未结束，已跳过本次", needs_review: "运行结束，业务结果需要核实" })[execution.status],
      sessionId: execution.sessionId,
    });
  }
  return entries;
}
