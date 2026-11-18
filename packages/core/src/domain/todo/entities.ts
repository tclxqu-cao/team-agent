export type TodoKind = "normal" | "scheduled";
export type TodoStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export interface OwnedRecord { id: string; ownerId: string }
export interface TodoTask extends OwnedRecord {
  kind: TodoKind; title: string; description: string; status: TodoStatus;
  dueAt?: number; timeZone?: string; projectId?: string; sourceSessionRef?: string;
  version: number; controlRevision: number; activeExecutionId?: string;
  createdAt: number; updatedAt: number;
}
export type TodoTrigger = { kind: "once"; at: number } | { kind: "cron"; expression: string };
export interface TodoReminderSchedule extends OwnedRecord {
  taskId: string; trigger: TodoTrigger; timeZone: string; enabled: boolean;
  generation: number; nextFireAt: number | null;
  origin?: "due" | "custom";
}
export interface TodoExecutionTarget {
  agentType: string; model?: string; cwd: string; permissionMode: "default" | "acceptEdits" | "bypassPermissions";
}
export interface TodoExecutionSchedule extends TodoReminderSchedule { target: TodoExecutionTarget }
export interface TodoScheduleLink extends OwnedRecord { taskId: string; scheduleRef: string; label?: string }
export interface TodoReminderOccurrence extends OwnedRecord { taskId: string; scheduleId: string; generation: number; scheduledAt: number }
export type TodoExecutionStatus = "queued" | "running" | "waiting_for_human" | "succeeded" | "failed" | "cancelled" | "missed" | "skipped" | "needs_review";
export interface TodoExecution extends OwnedRecord {
  taskId: string; scheduleId: string; generation: number; scheduledAt: number;
  controlRevision: number; status: TodoExecutionStatus; target: TodoExecutionTarget;
  sessionId?: string; runId?: string; startedAt?: number; finishedAt?: number;
  report?: "progress" | "succeeded" | "failed"; summary?: string; error?: string;
}
export interface TodoExecutionReport extends OwnedRecord { executionId: string; outcome: "progress" | "succeeded" | "failed"; summary: string; createdAt: number }
export interface TodoCommandReceipt extends OwnedRecord { fingerprint: string; result: TodoDetail }
export interface TodoDetail {
  task: TodoTask; reminders: TodoReminderSchedule[]; links: TodoScheduleLink[];
  schedule?: TodoExecutionSchedule; executions: TodoExecution[]; executionCursor?: string;
}
export class TodoError extends Error {
  constructor(public readonly code: "INVALID_ARGUMENT" | "NOT_FOUND" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "FORBIDDEN" | "BUSY" | "UNAVAILABLE", message: string) { super(message); this.name = "TodoError"; }
}
export const isTodoTerminal = (task: TodoTask): boolean => task.status === "completed" || task.status === "cancelled";
export function assertVersion(task: TodoTask, version: number): void {
  if (!Number.isSafeInteger(version) || task.version !== version) throw new TodoError("VERSION_CONFLICT", "待办已被其他会话更新，请刷新后重试");
}
export function validateTimestamp(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8.64e15) throw new TodoError("INVALID_ARGUMENT", "时间必须是有效的 UTC 毫秒时间戳");
}
