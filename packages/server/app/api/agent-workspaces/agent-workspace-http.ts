import type { AgentType, WorkspaceQuery } from "@agent/native-runtime";

import { isAgentType } from "../../../../core/src/domain/agent/agent-type";

export const CUSTOMER_AGENT_RECENT_WORKSPACE_ID = "customer-agent:recent";

export function readAgentType(value: string | null): AgentType | null {
  return isAgentType(value) ? value : null;
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
