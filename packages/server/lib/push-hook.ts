import { agentHost } from "../app/api/agent-host";
import { getWebPushService } from "./web-push-service.mjs";
import { serverLogger } from "./global-logger";

let hooked = false;

/**
 * Idempotently routes session events (customer-agent and native) into Web
 * Push fan-out. Called from the entry routes that admit runs so the hook is
 * alive even when the phone that started a run goes offline immediately.
 */
export function ensurePushHook(): void {
  if (hooked) return;
  hooked = true;
  agentHost.setGlobalEventObserver((sessionId, event) => {
    try {
      if (event.type === "ask_user") {
        getWebPushService().notifySession({
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
        getWebPushService().notifySession({
          sessionId,
          kind: "done",
          title: "会话已完成",
          body: typeof event.finalText === "string" && event.finalText.trim()
            ? event.finalText.trim().slice(0, 160)
            : "运行已结束",
          url: "/app/",
        });
        return;
      }
      if (event.type === "error") {
        getWebPushService().notifySession({
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
