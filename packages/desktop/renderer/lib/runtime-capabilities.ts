import type { AgentType } from "../global";

export function supportsMidTurnSteering(agentType: AgentType | undefined): boolean {
  return agentType === "customer-agent" || agentType === "codex" || agentType === "claude-code"
    || agentType === "deepseek-harness" || agentType === "opencode" || agentType === "copilot";
}

export function usesNativeSessionPermissions(agentType: AgentType | undefined): boolean {
  return agentType === "deepseek-harness" || agentType === "copilot";
}
