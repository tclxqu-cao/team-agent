import type { AgentApi, AgentType, AgentWorkspace, UnifiedSessionSummary } from "../global";

/** Imported workspace IDs identify sidebar entries, not native runtime projects. */
export function createSessionForWorkspace(
  api: Pick<AgentApi, "createSession">,
  title: string,
  context: {
    projectId?: string;
    agentType: AgentType;
    workspaceSource?: AgentWorkspace["source"];
    workspacePath?: string | null;
  },
): Promise<UnifiedSessionSummary> {
  return api.createSession(
    title,
    context.workspaceSource === "imported" ? undefined : context.projectId,
    context.agentType,
    context.agentType !== "customer-agent" ? context.workspacePath ?? undefined : undefined,
  );
}

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
