import type { UnifiedSessionSummary } from "../global";

export function canForkOccupiedCodexSession(
  summary: UnifiedSessionSummary | undefined,
  errorCode?: string,
): boolean {
  return summary?.agentType === "codex"
    && (summary.occupancy === "owned-externally" || errorCode === "SESSION_OCCUPIED");
}

export async function forkOccupiedCodexSession(options: {
  sourceSessionId: string;
  forkSession: (id: string) => Promise<UnifiedSessionSummary>;
  activateSession: (id: string) => void;
  refreshAndSelect: (id: string) => void | Promise<void>;
}): Promise<UnifiedSessionSummary> {
  const forked = await options.forkSession(options.sourceSessionId);
  options.activateSession(forked.id);
  await options.refreshAndSelect(forked.id);
  return forked;
}
