import type { OwnedRecord } from "../todo/entities";
export interface PersistentNotification extends OwnedRecord {
    sourceEventId: string;
    kind: "completion" | "approval" | "todo_reminder" | "todo_execution";
    title: string;
    body: string;
    createdAt: number;
    readAt?: number;
    dismissedAt?: number;
    sessionId?: string;
    questionId?: string;
    taskId?: string;
    executionId?: string;
    cursor?: number;
    reminderScheduleId?: string;
    reminderGeneration?: number;
}
export interface NotificationDelivery extends OwnedRecord {
    notificationId: string;
    deviceId: string;
    leasedUntil: number;
    displayedAt?: number;
    acknowledgedAt?: number;
}
//# sourceMappingURL=entities.d.ts.map