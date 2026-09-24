import type { AgentType, UnifiedSessionSummary } from "../global";

export interface SessionComposerRoute {
  agentType: AgentType;
  ready: boolean;
}
export function resolveSessionComposerRoute(
  selectedSessionId: string | null | undefined,
  sessionSummary: UnifiedSessionSummary | undefined,
  activeAgentType: AgentType,
): SessionComposerRoute {
  if (!selectedSessionId) return { agentType: activeAgentType, ready: true };
  if (sessionSummary?.id !== selectedSessionId) return { agentType: activeAgentType, ready: false };
  return { agentType: sessionSummary.agentType, ready: true };
}
