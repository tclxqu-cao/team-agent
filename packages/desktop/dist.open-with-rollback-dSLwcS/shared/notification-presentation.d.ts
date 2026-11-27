import type { PersistentNotification } from "@agent/core";
export type NotificationSoundIntent = Pick<PersistentNotification, "kind" | "title">;
/** Legacy execution notices persist the scheduler's fixed result titles. */
export declare function notificationPresentation(notification: NotificationSoundIntent): {
    label: "会话已完成";
    sound: "completion.wav";
    type: "completion" | "approval" | "todo_reminder" | "todo_execution" | "todo_attention" | "todo_error";
} | {
    label: "需要确认";
    sound: "approval.wav";
    type: "completion" | "approval" | "todo_reminder" | "todo_execution" | "todo_attention" | "todo_error";
} | {
    label: "待办提醒";
    sound: "reminder.wav";
    type: "completion" | "approval" | "todo_reminder" | "todo_execution" | "todo_attention" | "todo_error";
} | {
    label: "定时待办";
    sound: "scheduled.wav";
    type: "completion" | "approval" | "todo_reminder" | "todo_execution" | "todo_attention" | "todo_error";
} | {
    label: "待办需关注";
    sound: "attention.wav";
    type: "completion" | "approval" | "todo_reminder" | "todo_execution" | "todo_attention" | "todo_error";
} | {
    label: "待办执行异常";
    sound: "error.wav";
    type: "completion" | "approval" | "todo_reminder" | "todo_execution" | "todo_attention" | "todo_error";
};
//# sourceMappingURL=notification-presentation.d.ts.map