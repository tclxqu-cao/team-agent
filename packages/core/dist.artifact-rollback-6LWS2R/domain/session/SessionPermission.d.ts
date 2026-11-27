import { ToolPermissionGate, type ToolPermissionGateOptions, type ToolPermissionMode } from "../tool/permissions.js";
import type { Session } from "./entities.js";
/**
 * Session permission/bootstrap policy shared by every agent host (desktop
 * Electron host and server API host). Both hosts used to carry byte-identical
 * copies of these operations; the transport-specific wiring stays local, the
 * domain policy lives here.
 */
/** Minimal store surface the policy needs (satisfied by SQLiteSessionStore). */
export interface AgentSessionPolicyStore {
    get(id: string): Promise<Session | null>;
    update(id: string, update: Partial<Session>): Promise<Session>;
}
/** Build the per-session permission gate: mode comes from session metadata, approval UI is host-specific. */
export declare function createSessionPermissionGate({ sessionStore, requestApproval }: {
    sessionStore: AgentSessionPolicyStore;
    requestApproval: ToolPermissionGateOptions["requestApproval"];
}): ToolPermissionGate;
/** Switch a session's permission mode; pending approvals for the old mode are invalidated. */
export declare function setSessionPermissionMode(store: AgentSessionPolicyStore, permissionGate: ToolPermissionGate, sessionId: string, mode: ToolPermissionMode): Promise<Session>;
/** Metadata bootstrap for a freshly created chat session (auto-title pending, full access). */
export declare function newSessionMetadata(title: string): Record<string, unknown>;
//# sourceMappingURL=SessionPermission.d.ts.map