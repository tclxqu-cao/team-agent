import type { TaskNotificationPreferences } from "../../domain/settings/entities.js";
export type { TaskNotificationPreferences } from "../../domain/settings/entities.js";
export declare const DEFAULT_TASK_NOTIFICATION_PREFERENCES: TaskNotificationPreferences;
export interface TaskCompletionSettlement {
    sessionId: string;
    runId: string;
    title: string;
    finalText?: string;
    outcome: "completed" | "failed" | "aborted";
    source: "user" | "goal" | "subagent" | "replay";
    goalFinished?: boolean;
    stale?: boolean;
}
export interface TaskCompletionNotification {
    notificationId: string;
    sessionId: string;
    runId: string;
    title: string;
    body: string;
}
export declare function resolveTaskNotificationPreferences(value?: Partial<TaskNotificationPreferences> | null): TaskNotificationPreferences;
export declare function createTaskCompletionNotification(settlement: TaskCompletionSettlement, preferences: TaskNotificationPreferences): TaskCompletionNotification | null;
export declare class NotificationDeduper {
    private readonly maxSize;
    private readonly delivered;
    constructor(maxSize?: number);
    accept(notificationId: string): boolean;
}
//# sourceMappingURL=task-completion.d.ts.map