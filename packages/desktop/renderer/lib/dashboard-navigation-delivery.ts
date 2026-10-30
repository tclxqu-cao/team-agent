import {
  postDashboardIntent as postIntent,
  readSessionDashboardIntent,
  SESSION_DASHBOARD_APPLIED,
  SESSION_DASHBOARD_CHAT_READY,
  type SessionDashboardIntent,
} from "../../../core/src/domain/web-console/SessionDashboardBridge";

let cancelPending: (() => void) | undefined;

/** Retain the click across a chat iframe reload, without replaying an applied selection. */
export function postDashboardIntent(intent: SessionDashboardIntent): void {
  cancelPending?.();
  if (intent.kind === "session" && window.parent !== window && document.body.dataset.agentroamChatNavigation !== "ready") {
    const parent = window.parent;
    const origin = window.location.origin;
    const readyInstances = new Set<string>();
    const cancel = () => {
      parent.removeEventListener("message", receive);
      window.removeEventListener("pagehide", cancel);
      clearTimeout(timer);
      if (cancelPending === cancel) cancelPending = undefined;
    };
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || !event.source || event.source === window
        || !Array.from({ length: parent.frames.length }, (_, index) => parent.frames[index]).includes(event.source as Window)) return;
      if (event.data?.type === SESSION_DASHBOARD_APPLIED && event.data.sessionId === intent.session.id) {
        cancel();
      } else if (event.data?.type === SESSION_DASHBOARD_CHAT_READY && typeof event.data.instanceId === "string" && !readyInstances.has(event.data.instanceId)) {
        readyInstances.add(event.data.instanceId);
        postIntent(intent);
      } else if (readSessionDashboardIntent(event, origin, event.source)) {
        // A newer choice in another pane supersedes this pending click.
        cancel();
      }
    };
    const timer = setTimeout(cancel, 30_000);
    cancelPending = cancel;
    parent.addEventListener("message", receive);
    window.addEventListener("pagehide", cancel, { once: true });
  }
  postIntent(intent);
}
