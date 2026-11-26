import { randomUUID, createHash } from "node:crypto";
import { assertVersion, isTodoTerminal, TodoError, validateTimestamp, type TodoTask, type TodoDetail, type TodoTrigger } from "../../domain/todo/entities";
import type { ITodoUnitOfWork, TodoTransaction } from "../../domain/todo/ports";
import { ReminderScheduleCalculator } from "../../domain/todo/ReminderScheduleCalculator";
import type { TodoCommand, TodoCommandContext, TodoListQuery } from "./contracts";
import { normalizedTodoTitle } from "./completed-work";
import { dismissTaskReminders } from "../notification/NotificationService";
const canonical = (v: unknown): string => v && typeof v === "object" ? Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}` : JSON.stringify(v);
export function todoDetail(tx: TodoTransaction, ownerId: string, id: string): TodoDetail {
  const task = tx.todo_tasks.get(ownerId, id);
  if (!task) throw new TodoError("NOT_FOUND", "待办不存在");
  const executions = tx.todo_executions.list(ownerId).filter(x => x.taskId === id).sort((a, b) => b.scheduledAt - a.scheduledAt || b.id.localeCompare(a.id));
  return { task, reminders: tx.todo_reminder_schedules.list(ownerId).filter(x => x.taskId === id), links: tx.todo_schedule_links.list(ownerId).filter(x => x.taskId === id), schedule: tx.todo_execution_schedules.list(ownerId).find(x => x.taskId === id), executions: executions.slice(0, 10), ...(executions.length > 10 ? { executionCursor: executions[9].id } : {}) };
}
export class TodoApplicationService {
  constructor(readonly uow: ITodoUnitOfWork, private readonly clock = Date.now, private readonly calculator = new ReminderScheduleCalculator()) {}
  get(id: string, ownerId: string): TodoDetail { return this.uow.run(tx => todoDetail(tx, ownerId, id)); }
  completeReportedWork(titles: readonly string[], startedAt: number, context: { ownerId: string; sessionId: string; runId: string }): void {
    if (!titles.length || !Number.isFinite(startedAt) || !context.runId) return;
    const reported = new Set(titles.map(normalizedTodoTitle).filter(Boolean));
    this.uow.run(tx => {
      const matches = new Map<string, TodoTask | null>();
      for (const task of tx.todo_tasks.list(context.ownerId)) {
        if (task.kind !== "normal" || task.createdAt > startedAt) continue;
        if (task.updatedAt < startedAt && task.status !== "pending" && task.status !== "in_progress") continue;
        const title = normalizedTodoTitle(task.title);
        if (reported.has(title)) matches.set(title, matches.has(title) ? null : task);
      }
      for (const task of matches.values()) {
        if (!task || task.updatedAt > startedAt || (task.updatedAt === startedAt && task.version > 1)) continue;
        if (task.status !== "pending" && task.status !== "in_progress") continue;
        this.execute({ type: "complete", taskId: task.id, expectedVersion: task.version }, {
          ownerId: context.ownerId, sourceSessionRef: context.sessionId, requestId: `run-complete:${context.runId}:${task.id}`,
        });
      }
    });
  }
  list(query: TodoListQuery, ownerId: string) {
    return this.uow.run(tx => {
      let tasks = tx.todo_tasks.list(ownerId).filter(t => (!query.status || t.status === query.status) && (!query.kind || t.kind === query.kind)).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
      if (query.cursor) { const at = tasks.findIndex(t => t.id === query.cursor); tasks = at < 0 ? [] : tasks.slice(at + 1); }
      const limit = Math.max(1, Math.min(200, Number(query.limit) || 50)), page = tasks.slice(0, limit);
      return { items: page.map(t => todoDetail(tx, ownerId, t.id)), ...(tasks.length > limit ? { cursor: page[page.length - 1].id } : {}) };
    });
  }
  executions(id: string, ownerId: string, cursor?: string) {
    return this.uow.run(tx => {
      todoDetail(tx, ownerId, id);
      let all = tx.todo_executions.list(ownerId).filter(x => x.taskId === id).sort((a, b) => b.scheduledAt - a.scheduledAt || b.id.localeCompare(a.id));
      if (cursor) { const at = all.findIndex(x => x.id === cursor); all = at < 0 ? [] : all.slice(at + 1); }
      return { items: all.slice(0, 10), ...(all.length > 10 ? { cursor: all[9].id } : {}) };
    });
  }
  execute(command: TodoCommand, context: TodoCommandContext): TodoDetail {
    if (!command || !["create", "update", "start", "complete", "cancel", "reopen", "remind", "linkSchedule", "schedule"].includes(command.type)) throw new TodoError("INVALID_ARGUMENT", "未知待办操作");
    if (command.type !== "create") text(command.taskId, 200);
    if (!context.ownerId || typeof context.requestId !== "string" || context.requestId.length < 1 || context.requestId.length > 200) throw new TodoError("INVALID_ARGUMENT", "写操作需要稳定的 requestId");
    const fingerprint = createHash("sha256").update(canonical(command)).digest("hex");
    const receiptId = createHash("sha256").update(`${context.ownerId}\0${context.requestId}`).digest("hex");
    return this.uow.run(tx => {
      const receipt = tx.todo_command_receipts.get(context.ownerId, receiptId);
      if (receipt) { if (receipt.fingerprint !== fingerprint) throw new TodoError("IDEMPOTENCY_CONFLICT", "同一 requestId 不能用于不同操作"); return receipt.result; }
      const now = this.clock();
      let task: TodoTask;
      if (command.type === "create") {
        if (command.kind && !["normal", "scheduled"].includes(command.kind)) throw new TodoError("INVALID_ARGUMENT", "无效的待办类型");
        if (command.dueAt !== undefined) validateTimestamp(command.dueAt);
        task = { id: randomUUID(), ownerId: context.ownerId, title: text(command.title, 300), description: text(command.description ?? "", 20000, true), kind: command.kind ?? "normal", status: "pending", timeZone: command.timeZone ?? "Asia/Shanghai", version: 1, controlRevision: 0, createdAt: now, updatedAt: now, ...(command.dueAt !== undefined ? { dueAt: command.dueAt } : {}), ...(command.projectId ? { projectId: text(command.projectId, 200) } : {}), ...(context.sourceSessionRef ? { sourceSessionRef: context.sourceSessionRef } : {}) };
        this.calculator.next({ kind: "once", at: now + 1 }, task.timeZone!, now);
        const reminder = command.reminder === undefined ? command.dueAt !== undefined && command.dueAt > now ? { kind: "once" as const, at: command.dueAt } : undefined : command.reminder;
        if (reminder) tx.todo_reminder_schedules.put({ id: randomUUID(), ownerId: task.ownerId, taskId: task.id, trigger: reminder, timeZone: task.timeZone!, enabled: true, generation: 1, nextFireAt: this.next(reminder, task.timeZone!, now), origin: command.reminder === undefined ? "due" : "custom" });
        else if (command.reminder === null) tx.todo_reminder_schedules.put({ id: randomUUID(), ownerId: task.ownerId, taskId: task.id, trigger: { kind: "once", at: task.dueAt ?? now }, timeZone: task.timeZone!, enabled: false, generation: 1, nextFireAt: null, origin: "custom" });
        if (command.executionSchedule) {
          if (task.kind !== "scheduled") throw new TodoError("INVALID_ARGUMENT", "只有定时任务类型可以设置自动执行计划");
          const schedule = command.executionSchedule, timeZone = schedule.timeZone ?? task.timeZone!, target = schedule.target;
          if (!target) throw new TodoError("INVALID_ARGUMENT", "执行计划缺少 Agent 配置");
          text(target.agentType, 100); text(target.cwd, 4000);
          if (!["default", "acceptEdits", "bypassPermissions"].includes(target.permissionMode)) throw new TodoError("INVALID_ARGUMENT", "无效的权限设置");
          const nextFireAt = this.next(schedule.trigger, timeZone, now);
          tx.todo_execution_schedules.put({ id: randomUUID(), ownerId: task.ownerId, taskId: task.id, trigger: schedule.trigger, target, timeZone, enabled: schedule.enabled !== false, generation: 1, nextFireAt: schedule.enabled === false ? null : nextFireAt });
        }
        if (command.scheduleRef) tx.todo_schedule_links.put({ id: randomUUID(), ownerId: task.ownerId, taskId: task.id, scheduleRef: text(command.scheduleRef, 2000) });
      } else {
        task = tx.todo_tasks.get(context.ownerId, command.taskId)!;
        if (!task) throw new TodoError("NOT_FOUND", "待办不存在");
        assertVersion(task, command.expectedVersion);
        if (command.type === "update") {
          const oldDueAt = task.dueAt;
          if (!command.patch || typeof command.patch !== "object") throw new TodoError("INVALID_ARGUMENT", "缺少修改内容");
          if (command.patch.title !== undefined) task.title = text(command.patch.title, 300);
          if (command.patch.description !== undefined) task.description = text(command.patch.description, 20000, true);
          if (command.patch.dueAt === null) delete task.dueAt;
          else if (command.patch.dueAt !== undefined) { validateTimestamp(command.patch.dueAt); task.dueAt = command.patch.dueAt; }
          if (command.patch.projectId !== undefined) task.projectId = text(command.patch.projectId, 200, true);
          if (task.dueAt !== oldDueAt && !isTodoTerminal(task)) {
            const old = tx.todo_reminder_schedules.list(context.ownerId).find(s => s.taskId === task.id);
            if (!old || old.origin === "due") {
              dismissTaskReminders(tx, context.ownerId, task.id, now);
              const enabled = task.dueAt !== undefined && task.dueAt > now;
              tx.todo_reminder_schedules.put({ id: old?.id ?? randomUUID(), ownerId: task.ownerId, taskId: task.id, trigger: { kind: "once", at: task.dueAt ?? now }, timeZone: task.timeZone ?? "Asia/Shanghai", enabled, nextFireAt: enabled ? task.dueAt! : null, generation: (old?.generation ?? 0) + 1, origin: "due" });
            }
          }
        } else if (["start", "complete", "cancel", "reopen"].includes(command.type)) {
          if (isTodoTerminal(task) && command.type === "start") throw new TodoError("INVALID_ARGUMENT", "请先重新打开待办");
          task.status = ({ start: "in_progress", complete: "completed", cancel: "cancelled", reopen: "pending" } as const)[command.type as "start" | "complete" | "cancel" | "reopen"];
          task.controlRevision++;
          if (command.type !== "start") {
            dismissTaskReminders(tx, context.ownerId, task.id, now);
            delete task.activeExecutionId;
            for (const schedule of tx.todo_reminder_schedules.list(context.ownerId).filter(s => s.taskId === task.id)) tx.todo_reminder_schedules.put({ ...schedule, enabled: false, generation: schedule.generation + 1, nextFireAt: null });
            for (const schedule of tx.todo_execution_schedules.list(context.ownerId).filter(s => s.taskId === task.id)) tx.todo_execution_schedules.put({ ...schedule, enabled: false, generation: schedule.generation + 1, nextFireAt: null });
          }
        } else if (command.type === "remind") {
          dismissTaskReminders(tx, context.ownerId, task.id, now);
          if (isTodoTerminal(task) && command.trigger) throw new TodoError("INVALID_ARGUMENT", "已结束待办不能设置提醒");
          const old = tx.todo_reminder_schedules.list(context.ownerId).find(s => s.taskId === task.id);
          const timeZone = command.timeZone ?? old?.timeZone ?? "Asia/Shanghai";
          const nextFireAt = command.trigger ? this.next(command.trigger, timeZone, now) : null;
          tx.todo_reminder_schedules.put({ id: old?.id ?? randomUUID(), ownerId: context.ownerId, taskId: task.id, trigger: command.trigger ?? old?.trigger ?? { kind: "once", at: now }, timeZone, enabled: !!command.trigger, generation: (old?.generation ?? 0) + 1, nextFireAt, origin: "custom" });
        } else if (command.type === "linkSchedule") {
          const scheduleRef = text(command.scheduleRef, 2000);
          const id = createHash("sha256").update(`${task.id}:${scheduleRef}`).digest("hex");
          tx.todo_schedule_links.put({ id, ownerId: context.ownerId, taskId: task.id, scheduleRef, ...(command.label ? { label: text(command.label, 300) } : {}) });
        } else if (command.type === "schedule") {
          if (task.kind !== "scheduled") throw new TodoError("INVALID_ARGUMENT", "只有定时任务类型可以自动执行；提醒和关联不会改变待办类型");
          if (typeof command.enabled !== "boolean") throw new TodoError("INVALID_ARGUMENT", "请指定是否启用执行计划");
          if (isTodoTerminal(task) && command.enabled) throw new TodoError("INVALID_ARGUMENT", "请先重新打开待办");
          const old = tx.todo_execution_schedules.list(context.ownerId).find(s => s.taskId === task.id);
          if (task.activeExecutionId && (command.trigger || command.target || command.timeZone)) throw new TodoError("BUSY", "执行中不能更换触发规则或 Agent，可暂停后续执行");
          const target = command.target ?? old?.target, trigger = command.trigger ?? old?.trigger;
          if (!target || !trigger) throw new TodoError("INVALID_ARGUMENT", "执行计划需要触发规则和 Agent 配置");
          text(target.agentType, 100); text(target.cwd, 4000);
          if (!["default", "acceptEdits", "bypassPermissions"].includes(target.permissionMode)) throw new TodoError("INVALID_ARGUMENT", "无效的权限设置");
          const timeZone = command.timeZone ?? old?.timeZone ?? "Asia/Shanghai";
          tx.todo_execution_schedules.put({ id: old?.id ?? randomUUID(), ownerId: context.ownerId, taskId: task.id, trigger, timeZone, target, generation: (old?.generation ?? 0) + 1, enabled: command.enabled, nextFireAt: command.enabled ? this.next(trigger, timeZone, now) : null });
        } else throw new TodoError("INVALID_ARGUMENT", "未知待办操作");
        task.version++; task.updatedAt = now;
      }
      tx.todo_tasks.put(task);
      const result = todoDetail(tx, context.ownerId, task.id);
      tx.todo_command_receipts.put({ id: receiptId, ownerId: context.ownerId, fingerprint, result });
      return result;
    });
  }
  private next(trigger: TodoTrigger, timeZone: string, now: number): number {
    const next = this.calculator.next(trigger, timeZone, now);
    if (next === null) throw new TodoError("INVALID_ARGUMENT", "触发时间必须在未来且有有效的下一次触发");
    return next;
  }
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > limit) throw new TodoError("INVALID_ARGUMENT", `文本不能为空且不能超过 ${limit} 字符`);
  return value.trim();
}
