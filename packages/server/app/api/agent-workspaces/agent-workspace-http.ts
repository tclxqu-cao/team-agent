import type { AgentType, WorkspaceQuery } from "@agent/native-runtime";

const AGENT_TYPES = new Set<AgentType>(["customer-agent", "codex", "claude-code", "opencode"]);

export function readAgentType(value: string | null): AgentType | null {
  return value && AGENT_TYPES.has(value as AgentType) ? value as AgentType : null;
}

export function readWorkspaceQuery(url: URL): WorkspaceQuery {
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? 50 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("limit must be an integer between 1 and 200");
  }
  return {
    cursor: url.searchParams.get("cursor"),
    since: url.searchParams.get("since"),
    refresh: url.searchParams.get("refresh") === "1",
    limit,
  };
}
