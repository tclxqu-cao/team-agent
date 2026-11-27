import type { TodoTask, TodoKind, TodoStatus, TodoTrigger, TodoExecutionTarget } from "../../domain/todo/entities";
export interface TodoCommandContext {
    ownerId: string;
    requestId: string;
    sourceSessionRef?: string;
}
type Existing = {
    taskId: string;
    expectedVersion: number;
};
export type TodoCommand = {
    type: "create";
    title: string;
    description?: string;
    kind?: TodoKind;
    dueAt?: number;
    projectId?: string;
    timeZone?: string;
    reminder?: TodoTrigger | null;
    scheduleRef?: string;
    executionSchedule?: {
        trigger: TodoTrigger;
        target: TodoExecutionTarget;
        timeZone?: string;
        enabled?: boolean;
    };
} | (Existing & {
    type: "update";
    patch: Partial<Pick<TodoTask, "title" | "description" | "projectId">> & {
        dueAt?: number | null;
    };
}) | (Existing & {
    type: "start" | "complete" | "cancel" | "reopen";
}) | (Existing & {
    type: "remind";
    trigger: TodoTrigger | null;
    timeZone?: string;
}) | (Existing & {
    type: "linkSchedule";
    scheduleRef: string;
    label?: string;
}) | (Existing & {
    type: "schedule";
    trigger?: TodoTrigger;
    timeZone?: string;
    target?: TodoExecutionTarget;
    enabled: boolean;
});
export interface TodoListQuery {
    status?: TodoStatus;
    kind?: TodoKind;
    limit?: number;
    cursor?: string;
}
export {};
//# sourceMappingURL=contracts.d.ts.map