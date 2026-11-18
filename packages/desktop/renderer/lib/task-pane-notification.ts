export const TASK_PANE_NOTIFICATION_EVENT = "agentroam:task-pane-notification";

export interface TaskPaneNotificationRequest { sessionId: string }

/** A split workspace claims the notification synchronously, before session loading. */
export function requestTaskPaneNotification(sessionId: string): boolean {
  return !window.dispatchEvent(new CustomEvent<TaskPaneNotificationRequest>(TASK_PANE_NOTIFICATION_EVENT, {
    cancelable: true, detail: { sessionId },
  }));
}
