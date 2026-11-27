const PRESENTATIONS = {
    completion: { label: "会话已完成", sound: "completion.wav" },
    approval: { label: "需要确认", sound: "approval.wav" },
    todo_reminder: { label: "待办提醒", sound: "reminder.wav" },
    todo_execution: { label: "定时待办", sound: "scheduled.wav" },
    todo_attention: { label: "待办需关注", sound: "attention.wav" },
    todo_error: { label: "待办执行异常", sound: "error.wav" },
};
/** Legacy execution notices persist the scheduler's fixed result titles. */
export function notificationPresentation(notification) {
    let type = notification.kind;
    if (notification.kind === "todo_execution") {
        if (notification.title === "定时待办执行未完成")
            type = "todo_error";
        else if (notification.title === "定时待办错过执行" || notification.title === "定时待办需要核实")
            type = "todo_attention";
    }
    return { type, ...PRESENTATIONS[type] };
}
//# sourceMappingURL=notification-presentation.js.map