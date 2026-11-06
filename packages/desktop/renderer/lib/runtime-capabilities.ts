import type { AgentType, UnifiedSessionSummary } from "../global";

export function canGuideExternalSession(session: Pick<UnifiedSessionSummary,
  "agentType" | "occupancy" | "status" | "readOnly" | "externalGuideSupported"> | null | undefined): boolean {
  return session?.agentType === "zcode" && session.occupancy === "owned-externally"
    && session.status === "running" && session.readOnly !== true && session.externalGuideSupported === true;
}

export function supportsMidTurnSteering(agentType: AgentType | undefined): boolean {
  return agentType === "customer-agent" || agentType === "codex" || agentType === "claude-code"
    || agentType === "deepseek-harness" || agentType === "opencode" || agentType === "copilot" || agentType === "zcode";
}

export function usesNativeSessionPermissions(agentType: AgentType | undefined): boolean {
  return agentType === "deepseek-harness" || agentType === "copilot";
}
