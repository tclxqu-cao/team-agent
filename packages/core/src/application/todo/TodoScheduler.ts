import { randomUUID, createHash } from "node:crypto";
import { isTodoTerminal, TodoError, type TodoExecution } from "../../domain/todo/entities";
import type { ITodoUnitOfWork } from "../../domain/todo/ports";
import { ReminderScheduleCalculator } from "../../domain/todo/ReminderScheduleCalculator";
import { persistNotification, dismissTaskReminders } from "../notification/NotificationService";
const occurrenceId = (id: string, generation: number, at: number) => createHash("sha256").update(`${id}:${generation}:${at}`).digest("hex");
export class TodoScheduler {
  constructor(private readonly uow: ITodoUnitOfWork, private readonly calculator = new ReminderScheduleCalculator()) {}
  tick(now: number) {
    return this.uow.run(tx => {
      let reminded = 0, queued = 0, missed = 0, skipped = 0;
      for (const s of tx.todo_reminder_schedules.list()) {
        if (!s.enabled || s.nextFireAt === null || s.nextFireAt > now) continue;
        const task = tx.todo_tasks.get(s.ownerId, s.taskId);
        if (!task || isTodoTerminal(task)) continue;
        const scheduledAt = this.calculator.previous(s.trigger, s.timeZone, now) ?? s.nextFireAt;
        const id = occurrenceId(s.id, s.generation, scheduledAt);
        if (!tx.todo_reminder_occurrences.get(s.ownerId, id)) {
          tx.todo_reminder_occurrences.put({ id, ownerId: s.ownerId, taskId: task.id, scheduleId: s.id, generation: s.generation, scheduledAt });
          persistNotification(tx, { ownerId: s.ownerId, sourceEventId: `reminder:${id}`, kind: "todo_reminder", taskId: task.id, reminderScheduleId: s.id, reminderGeneration: s.generation, title: "待办提醒", body: task.title, createdAt: now });
          reminded++;
        }
        s.nextFireAt = this.calculator.next(s.trigger, s.timeZone, now);
        if (s.nextFireAt === null) s.enabled = false;
        tx.todo_reminder_schedules.put(s);
      }
      for (const s of tx.todo_execution_schedules.list()) {
        if (!s.enabled || s.nextFireAt === null || s.nextFireAt > now) continue;
        const task = tx.todo_tasks.get(s.ownerId, s.taskId);
        if (!task || task.kind !== "scheduled" || isTodoTerminal(task)) continue;
        const id = occurrenceId(s.id, s.generation, s.nextFireAt);
        if (!tx.todo_executions.get(s.ownerId, id)) {
          const late = now - s.nextFireAt > 300000;
          const busy = !!task.activeExecutionId;
          const execution: TodoExecution = { id, ownerId: s.ownerId, taskId: task.id, scheduleId: s.id, generation: s.generation, scheduledAt: s.nextFireAt, controlRevision: task.controlRevision, status: busy ? "skipped" : late ? "missed" : "queued", target: s.target };
          tx.todo_executions.put(execution);
          if (busy) skipped++;
          else if (late) {
            missed++;
            persistNotification(tx, { ownerId: task.ownerId, sourceEventId: `execution:${id}:missed`, kind: "todo_execution", taskId: task.id, executionId: id, title: "定时待办错过执行", body: task.title, createdAt: now });
          } else { task.activeExecutionId = id; task.version++; task.updatedAt = now; tx.todo_tasks.put(task); queued++; }
        }
        s.nextFireAt = this.calculator.next(s.trigger, s.timeZone, now);
        if (s.nextFireAt === null) s.enabled = false;
        tx.todo_execution_schedules.put(s);
      }
      return { reminded, queued, missed, skipped };
    });
  }
}
/** A business success report is only a candidate. The authoritative runtime
 * must also complete successfully before the Todo can be checked off. */
export class TodoExecutionService {
  constructor(private readonly uow: ITodoUnitOfWork, private readonly clock = Date.now) {}
  pending() { return this.uow.run(tx => tx.todo_executions.list().filter(e => ["queued", "running", "waiting_for_human"].includes(e.status))); }
  bind(ownerId: string, executionId: string, sessionId: string, runId?: string) {
    return this.uow.run(tx => {
      const e = tx.todo_executions.get(ownerId, executionId); if (!e) throw new TodoError("NOT_FOUND", "执行不存在");
      if (e.sessionId && e.sessionId !== sessionId || e.runId && runId && e.runId !== runId) throw new TodoError("VERSION_CONFLICT", "执行已绑定其他运行");
      if (runId && !e.runId) {
        const current = tx.todo_tasks.get(ownerId, e.taskId);
        if (!current || current.activeExecutionId !== e.id || current.controlRevision !== e.controlRevision || isTodoTerminal(current)) throw new TodoError("VERSION_CONFLICT", "用户已更改待办，禁止启动过期执行");
        if (this.clock() - e.scheduledAt > 300000) throw new TodoError("VERSION_CONFLICT", "执行启动已超过五分钟宽限期");
      }
      if (!["queued", "running", "waiting_for_human"].includes(e.status)) return e;
      if (e.sessionId === sessionId && e.runId === runId) return e;
      e.sessionId = sessionId; if (runId) e.runId = runId;
      if (runId) { e.status = "running"; e.startedAt ??= this.clock(); }
      tx.todo_executions.put(e);
      const task = tx.todo_tasks.get(ownerId, e.taskId);
      if (runId && task?.activeExecutionId === e.id && task.controlRevision === e.controlRevision && !isTodoTerminal(task)) { task.status = "in_progress"; task.version++; task.updatedAt = this.clock(); tx.todo_tasks.put(task); }
      return e;
    });
  }
  report(ownerId: string, executionId: string, runId: string, requestId: string, outcome: "progress" | "succeeded" | "failed", summary: string) {
    if (!requestId || requestId.length > 200 || !["progress", "succeeded", "failed"].includes(outcome) || typeof summary !== "string" || summary.length > 20000) throw new TodoError("INVALID_ARGUMENT", "执行报告参数无效");
    return this.uow.run(tx => {
      const e = tx.todo_executions.get(ownerId, executionId);
      if (!e || !e.runId || e.runId !== runId) throw new TodoError("FORBIDDEN", "报告仅限当前已绑定的执行");
      const id = occurrenceId(executionId, 0, 0) + createHash("sha256").update(requestId).digest("hex");
      const old = tx.todo_execution_reports.get(ownerId, id);
      if (old) { if (old.outcome !== outcome || old.summary !== summary) throw new TodoError("IDEMPOTENCY_CONFLICT", "报告 requestId 已被使用"); return old; }
      if (!["running", "waiting_for_human"].includes(e.status)) throw new TodoError("VERSION_CONFLICT", "该次执行已结束");
      const task = tx.todo_tasks.get(ownerId, e.taskId);
      if (!task || task.activeExecutionId !== executionId || task.controlRevision !== e.controlRevision || isTodoTerminal(task)) throw new TodoError("VERSION_CONFLICT", "待办已由用户更改，本次执行不能继续更新");
      const report = { id, ownerId, executionId, outcome, summary: summary.trim(), createdAt: this.clock() };
      tx.todo_execution_reports.put(report); e.status = "running"; e.report = outcome; e.summary = report.summary; tx.todo_executions.put(e);
      return report;
    });
  }
  settle(ownerId: string, executionId: string, runtimeStatus: "completed" | "failed" | "cancelled" | "interrupted", error?: string) {
    return this.uow.run(tx => {
      const e = tx.todo_executions.get(ownerId, executionId);
      if (!e) throw new TodoError("NOT_FOUND", "执行不存在");
      if (!["queued", "running", "waiting_for_human"].includes(e.status)) return e;
      e.status = runtimeStatus === "completed" ? e.report === "succeeded" ? "succeeded" : e.report === "failed" ? "failed" : "needs_review" : runtimeStatus === "cancelled" ? "cancelled" : "failed";
      e.finishedAt = this.clock(); e.error = error;
      tx.todo_executions.put(e);
      const task = tx.todo_tasks.get(ownerId, e.taskId);
      if (task && task.activeExecutionId === e.id && task.controlRevision === e.controlRevision && !isTodoTerminal(task)) {
        const schedule = tx.todo_execution_schedules.get(ownerId, e.scheduleId);
        task.status = e.status === "succeeded" ? schedule?.trigger.kind === "cron" ? "pending" : "completed" : "failed";
        if (task.status === "completed") {
          dismissTaskReminders(tx, ownerId, task.id, this.clock());
          for (const reminder of tx.todo_reminder_schedules.list(ownerId).filter(r => r.taskId === task.id)) tx.todo_reminder_schedules.put({ ...reminder, enabled: false, generation: reminder.generation + 1, nextFireAt: null });
        }
        delete task.activeExecutionId; task.version++; task.updatedAt = this.clock(); tx.todo_tasks.put(task);
        persistNotification(tx, { ownerId, sourceEventId: `execution:${e.id}:result`, kind: "todo_execution", taskId: task.id, sessionId: e.sessionId, executionId: e.id, title: e.status === "succeeded" ? "定时待办执行完成" : e.status === "needs_review" ? "定时待办需要核实" : "定时待办执行未完成", body: `${task.title}${e.summary ? `：${e.summary}` : error ? `：${error}` : ""}`.slice(0, 500), createdAt: this.clock() });
      }
      return e;
    });
  }
}
