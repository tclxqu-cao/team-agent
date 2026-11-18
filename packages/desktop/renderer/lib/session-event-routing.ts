import { isNativeAgentType, type AgentType } from "../../../core/src/domain/agent/agent-type";

export function resolveSessionEventTarget(eventSessionId: unknown): string | null {
  return typeof eventSessionId === "string" && eventSessionId.trim().length > 0
    ? eventSessionId
    : null;
}

export function resolveSessionAgentType(
  targetSessionId: string,
  selectedSessionId: string | null | undefined,
  selectedAgentType: AgentType | null | undefined,
): AgentType | undefined {
  // Native identity is available before metadata, which may still describe the previous selection.
  if (targetSessionId.startsWith("runtime:")) {
    const match = /^runtime:([^:]+):[A-Za-z0-9_-]+$/.exec(targetSessionId);
    return match && isNativeAgentType(match[1]) ? match[1] : undefined;
  }
  return targetSessionId === selectedSessionId ? selectedAgentType ?? undefined : undefined;
}
