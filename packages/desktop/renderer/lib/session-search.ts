export function mergeSearchSessions<T extends { id: string; agentType: string }>(
  remote: readonly T[],
  loaded: readonly T[],
  agentType: string,
): T[] {
  return [...new Map([...remote, ...loaded]
    .filter(session => session.agentType === agentType)
    .map(session => [session.id, session])).values()];
}

export function resolveChatSessionId(
  selected: string | null,
  stored: string | null,
  agentType: string,
  welcome: boolean,
): string | null {
  if (welcome) return null;
  if (selected) return selected;
  if (!stored) return null;
  return stored.startsWith("runtime:")
    ? stored.startsWith(`runtime:${agentType}:`) ? stored : null
    : agentType === "customer-agent" ? stored : null;
}
