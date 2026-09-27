import { agentHost } from "../app/api/agent-host";
import { getWebPushService } from "./web-push-service.mjs";
import { serverLogger } from "./global-logger";
import {
  NotificationDeduper,
  createTaskCompletionNotification,
  resolveTaskNotificationPreferences,
} from "@agent/core";
import { sharedSettings } from "./shared-settings";

let hooked = false;
const completionDeduper = new NotificationDeduper();

/**
 * Idempotently routes session events (customer-agent and native) into Web
 * Push fan-out. Called from the entry routes that admit runs so the hook is
 * alive even when the phone that started a run goes offline immediately.
 */
export function ensurePushHook(): void {
  if (hooked) return;
  hooked = true;
  agentHost.setGlobalEventObserver((sessionId, event, context) => {
    try {
      if (event.type === "ask_user") {
        getWebPushService().notifySession({
          notificationId: `${sessionId}:${event.questionId}:approval`,
          sessionId,
          kind: "approval",
          title: "需要你的审批",
          body: typeof event.question === "string" && event.question.trim()
            ? event.question.trim().slice(0, 160)
            : "会话正在等待确认",
          url: "/app/",
        });
        return;
      }
      if (event.type === "done") {
        if (context.source === "goal") return;
        const preferences = resolveTaskNotificationPreferences(sharedSettings().read().taskNotifications);
        const notification = context.runId ? createTaskCompletionNotification({
          sessionId,
          runId: context.runId,
          title: "任务已完成",
          finalText: event.finalText,
          outcome: "completed",
          source: "user",
        }, preferences) : null;
        if (notification && completionDeduper.accept(notification.notificationId)) {
          getWebPushService().notifySession({
            ...notification,
            url: `/app/?session=${encodeURIComponent(sessionId)}`,
          });
        }
        return;
      }
      if (event.type === "goal_updated" && event.goal.status === "complete") {
        const preferences = resolveTaskNotificationPreferences(sharedSettings().read().taskNotifications);
        const notification = createTaskCompletionNotification({
          sessionId,
          runId: `goal:${event.goal.createdAt}`,
          title: "目标已完成",
          finalText: event.goal.objective,
          outcome: "completed",
          source: "goal",
          goalFinished: true,
        }, preferences);
        if (notification && completionDeduper.accept(notification.notificationId)) {
          getWebPushService().notifySession({
            ...notification,
            url: `/app/?session=${encodeURIComponent(sessionId)}`,
          });
        }
        return;
      }
      if (event.type === "error") {
        getWebPushService().notifySession({
          notificationId: `${sessionId}:${context.runId ?? "unknown"}:error`,
          sessionId,
          kind: "error",
          title: "会话出错",
          body: typeof event.message === "string" && event.message.trim()
            ? event.message.trim().slice(0, 160)
            : "运行失败",
          url: "/app/",
        });
      }
    } catch (error) {
      serverLogger().warn("web push notify failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
