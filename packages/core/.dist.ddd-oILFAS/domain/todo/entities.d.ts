export type TodoKind = "normal" | "scheduled";
export type TodoStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";
export interface OwnedRecord {
    id: string;
    ownerId: string;
}
export interface TodoTask extends OwnedRecord {
    kind: TodoKind;
    title: string;
    description: string;
    status: TodoStatus;
    dueAt?: number;
    timeZone?: string;
    projectId?: string;
    sourceSessionRef?: string;
    version: number;
    controlRevision: number;
    activeExecutionId?: string;
    createdAt: number;
    updatedAt: number;
}
export type TodoTrigger = {
    kind: "once";
    at: number;
} | {
    kind: "cron";
    expression: string;
};
export interface TodoReminderSchedule extends OwnedRecord {
    taskId: string;
    trigger: TodoTrigger;
    timeZone: string;
    enabled: boolean;
    generation: number;
    nextFireAt: number | null;
    origin?: "due" | "custom";
}
export interface TodoExecutionTarget {
    agentType: string;
    model?: string;
    cwd: string;
    permissionMode: "default" | "acceptEdits" | "bypassPermissions";
}
export interface TodoExecutionSchedule extends TodoReminderSchedule {
    target: TodoExecutionTarget;
}
export interface TodoScheduleLink extends OwnedRecord {
    taskId: string;
    scheduleRef: string;
    label?: string;
}
export interface TodoReminderOccurrence extends OwnedRecord {
    taskId: string;
    scheduleId: string;
    generation: number;
    scheduledAt: number;
}
export type TodoExecutionStatus = "queued" | "running" | "waiting_for_human" | "succeeded" | "failed" | "cancelled" | "missed" | "skipped" | "needs_review";
export interface TodoExecution extends OwnedRecord {
    taskId: string;
    scheduleId: string;
    generation: number;
    scheduledAt: number;
    controlRevision: number;
    status: TodoExecutionStatus;
    target: TodoExecutionTarget;
    sessionId?: string;
    runId?: string;
    startedAt?: number;
    finishedAt?: number;
    report?: "progress" | "succeeded" | "failed";
    summary?: string;
    error?: string;
}
export interface TodoExecutionReport extends OwnedRecord {
    executionId: string;
    outcome: "progress" | "succeeded" | "failed";
    summary: string;
    createdAt: number;
}
export interface TodoCommandReceipt extends OwnedRecord {
    fingerprint: string;
    result: TodoDetail;
}
export interface TodoDetail {
    task: TodoTask;
    reminders: TodoReminderSchedule[];
    links: TodoScheduleLink[];
    schedule?: TodoExecutionSchedule;
    executions: TodoExecution[];
    executionCursor?: string;
}
export declare class TodoError extends Error {
    readonly code: "INVALID_ARGUMENT" | "NOT_FOUND" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "FORBIDDEN" | "BUSY" | "UNAVAILABLE";
    constructor(code: "INVALID_ARGUMENT" | "NOT_FOUND" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "FORBIDDEN" | "BUSY" | "UNAVAILABLE", message: string);
}
export declare const isTodoTerminal: (task: TodoTask) => boolean;
export declare function assertVersion(task: TodoTask, version: number): void;
export declare function validateTimestamp(value: unknown): asserts value is number;
//# sourceMappingURL=entities.d.ts.map