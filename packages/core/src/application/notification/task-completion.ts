import type { TaskNotificationPreferences } from "../../domain/settings/entities.js";

export type { TaskNotificationPreferences } from "../../domain/settings/entities.js";

export const DEFAULT_TASK_NOTIFICATION_PREFERENCES: TaskNotificationPreferences = {
  completionEnabled: true,
  soundEnabled: true,
  notifyWhileForeground: false,
};

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

function truncateCodePoints(value: string, max: number): string {
  const points = Array.from(value.trim());
  return points.length <= max ? points.join("") : `${points.slice(0, max - 1).join("")}…`;
}

export function resolveTaskNotificationPreferences(
  value?: Partial<TaskNotificationPreferences> | null,
): TaskNotificationPreferences {
  return {
    completionEnabled: value?.completionEnabled ?? DEFAULT_TASK_NOTIFICATION_PREFERENCES.completionEnabled,
    soundEnabled: value?.soundEnabled ?? DEFAULT_TASK_NOTIFICATION_PREFERENCES.soundEnabled,
    notifyWhileForeground: value?.notifyWhileForeground ?? DEFAULT_TASK_NOTIFICATION_PREFERENCES.notifyWhileForeground,
  };
}

export function createTaskCompletionNotification(
  settlement: TaskCompletionSettlement,
  preferences: TaskNotificationPreferences,
): TaskCompletionNotification | null {
  if (!preferences.completionEnabled || settlement.outcome !== "completed" || settlement.stale) return null;
  const eligibleSource = settlement.source === "user"
    || (settlement.source === "goal" && settlement.goalFinished === true);
  if (!eligibleSource || !settlement.sessionId || !settlement.runId) return null;
  return {
    notificationId: `${settlement.sessionId}:${settlement.runId}:completed`,
    sessionId: settlement.sessionId,
    runId: settlement.runId,
    title: truncateCodePoints(settlement.title, 80) || "任务已完成",
    body: truncateCodePoints(settlement.finalText ?? "", 160) || "运行已结束",
  };
}

export class NotificationDeduper {
  private readonly delivered = new Set<string>();

  constructor(private readonly maxSize = 500) {}

  accept(notificationId: string): boolean {
    if (!notificationId || this.delivered.has(notificationId)) return false;
    this.delivered.add(notificationId);
    while (this.delivered.size > this.maxSize) {
      const oldest = this.delivered.values().next().value as string | undefined;
      if (!oldest) break;
      this.delivered.delete(oldest);
    }
    return true;
  }
}
