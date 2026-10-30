import { isAgentType, type AgentType } from "../agent/agent-type.js";
import type { MonitoredSession } from "../supervision/types.js";

export const SESSION_DASHBOARD_NAVIGATE = "agentroam:session-dashboard-navigate:v1";
export const SESSION_DASHBOARD_READY = "agentroam:session-dashboard-ready:v1";
export const SESSION_DASHBOARD_CHAT_READY = "agentroam:session-dashboard-chat-ready:v1";
export const SESSION_DASHBOARD_APPLIED = "agentroam:session-dashboard-applied:v1";
export type SessionDashboardIntent =
  | { kind: "session"; session: MonitoredSession }
  | { kind: "agent"; agentType: AgentType }
  | { kind: "group"; groupId: string; title: string; discussionId?: string }
  | { kind: "groups" }
  | { kind: "dashboard" };

const shortId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,200}$/.test(value);
export function readSessionDashboardIntent(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  origin: string, source: MessageEventSource | null,
): SessionDashboardIntent | null {
  if (!source || event.source !== source || event.origin !== origin || event.data?.type !== SESSION_DASHBOARD_NAVIGATE) return null;
  const data = event.data.intent as Record<string, unknown> | undefined;
  if (!data) return null;
  if (data.kind === "dashboard" || data.kind === "groups") return { kind: data.kind };
  if (data.kind === "agent" && isAgentType(data.agentType)) return { kind: "agent", agentType: data.agentType };
  if (data.kind === "group" && shortId(data.groupId) && typeof data.title === "string" && data.title.length > 0 && data.title.length <= 100 && (data.discussionId === undefined || shortId(data.discussionId)))
    return { kind: "group", groupId: data.groupId, title: data.title, ...(data.discussionId ? { discussionId: data.discussionId as string } : {}) };
  if (data.kind === "session" && data.session && typeof data.session === "object") {
    const session = data.session as Record<string, unknown>;
    if (typeof session.id === "string" && session.id.length > 0 && session.id.length <= 400 && isAgentType(session.agentType) && typeof session.title === "string" && session.title.length <= 1000 && typeof session.cwd === "string" && session.cwd.length <= 4000 && (session.projectId === undefined || typeof session.projectId === "string" && session.projectId.length <= 400))
      return { kind: "session", session: { id: session.id, agentType: session.agentType, title: session.title, cwd: session.cwd, ...(session.projectId ? { projectId: session.projectId as string } : {}) } };
  }
  return null;
}

export function postDashboardIntent(intent: SessionDashboardIntent): void {
  if (document.body.dataset.agentroamChatNavigation === "ready") window.dispatchEvent(new CustomEvent(SESSION_DASHBOARD_NAVIGATE, { detail: intent }));
  else if (window.parent !== window) window.parent.postMessage({ type: SESSION_DASHBOARD_NAVIGATE, intent }, window.location.origin);
  else {
    if (intent.kind === "group") location.assign(`?view=collaboration&groupId=${encodeURIComponent(intent.groupId)}${intent.discussionId ? `&discussionId=${encodeURIComponent(intent.discussionId)}` : ""}`);
    else if (intent.kind === "groups") location.assign("?view=collaboration-dashboard");
    else if (intent.kind === "dashboard") location.assign("?view=session-dashboard");
    else if (intent.kind === "agent") location.assign(`?agent=${encodeURIComponent(intent.agentType)}`);
    else location.assign(`?agent=${encodeURIComponent(intent.session.agentType)}&session=${encodeURIComponent(intent.session.id)}`);
  }
}
