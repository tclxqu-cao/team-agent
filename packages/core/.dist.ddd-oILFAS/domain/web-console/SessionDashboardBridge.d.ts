import { type AgentType } from "../agent/agent-type.js";
import type { MonitoredSession } from "../supervision/types.js";
export declare const SESSION_DASHBOARD_NAVIGATE = "agentroam:session-dashboard-navigate:v1";
export declare const SESSION_DASHBOARD_READY = "agentroam:session-dashboard-ready:v1";
export declare const SESSION_DASHBOARD_CHAT_READY = "agentroam:session-dashboard-chat-ready:v1";
export declare const SESSION_DASHBOARD_APPLIED = "agentroam:session-dashboard-applied:v1";
export type SessionDashboardIntent = {
    kind: "session";
    session: MonitoredSession;
} | {
    kind: "agent";
    agentType: AgentType;
} | {
    kind: "group";
    groupId: string;
    title: string;
    discussionId?: string;
} | {
    kind: "groups";
} | {
    kind: "dashboard";
} | {
    kind: "new-session";
};
export declare function readSessionDashboardIntent(event: Pick<MessageEvent, "data" | "origin" | "source">, origin: string, source: MessageEventSource | null): SessionDashboardIntent | null;
export declare function postDashboardIntent(intent: SessionDashboardIntent): void;
//# sourceMappingURL=SessionDashboardBridge.d.ts.map