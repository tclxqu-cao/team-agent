import type { UnifiedSessionSummary } from "../global";

export interface OccupiedSessionError {
  sessionId: string;
  code: string;
}

export function isOccupiedSessionRecovery(
  sessionId: string | null | undefined,
  error: OccupiedSessionError | undefined,
): boolean {
  return Boolean(
    sessionId
    && error?.sessionId === sessionId
    && error.code === "SESSION_OCCUPIED",
  );
}

export function canForkOccupiedCodexSession(
  summary: UnifiedSessionSummary | undefined,
  error?: OccupiedSessionError,
): boolean {
  return (summary?.agentType === "codex" || summary?.agentType === "opencode")
    && (
      summary.occupancy === "owned-externally"
      || isOccupiedSessionRecovery(summary.id, error)
    );
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
