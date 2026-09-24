import type { AgentType } from "../global";

export function supportsMidTurnSteering(agentType: AgentType | undefined): boolean {
  return agentType === "customer-agent" || agentType === "codex" || agentType === "claude-code";
}
