import type { UnifiedSessionSummary } from "../global";

export interface OccupiedSessionError {
  sessionId: string;
  code: string;
}

export interface OccupiedSendPayload {
  content: string;
  images?: string[];
  agentIds?: string[];
  agentName?: string;
  restoreDraftOnFailure?: boolean;
}

export interface OccupiedSessionRecovery {
  token: string;
  sourceSessionId: string;
  forkSessionId?: string;
  payload: OccupiedSendPayload;
  sendAttempted: boolean;
}

export type OccupiedRecoveryRegistry = Record<string, OccupiedSessionRecovery>;

export function findOccupiedRecovery(
  recoveries: OccupiedRecoveryRegistry,
  sessionId: string | null | undefined,
): OccupiedSessionRecovery | undefined {
  return sessionId ? recoveries[sessionId] : undefined;
}

export function storeOccupiedRecovery(
  recoveries: OccupiedRecoveryRegistry,
  recovery: OccupiedSessionRecovery,
): OccupiedRecoveryRegistry {
  const next = Object.fromEntries(
    Object.entries(recoveries).filter(([, existing]) => (
      existing.token !== recovery.token
      && existing.sourceSessionId !== recovery.sourceSessionId
    )),
  );
  next[recovery.sourceSessionId] = recovery;
  if (recovery.forkSessionId) next[recovery.forkSessionId] = recovery;
  return next;
}

export function clearOccupiedRecovery(
  recoveries: OccupiedRecoveryRegistry,
  sessionId: string,
): OccupiedRecoveryRegistry {
  const recovery = recoveries[sessionId];
  if (!recovery) return recoveries;
  return Object.fromEntries(
    Object.entries(recoveries).filter(([, existing]) => existing.token !== recovery.token),
  );
}

export function createOccupiedSessionRecovery(
  sourceSessionId: string,
  payload: OccupiedSendPayload,
  token = crypto.randomUUID(),
): OccupiedSessionRecovery {
  return {
    token,
    sourceSessionId,
    payload: {
      ...payload,
      images: payload.images ? [...payload.images] : undefined,
      agentIds: payload.agentIds ? [...payload.agentIds] : undefined,
      restoreDraftOnFailure: payload.restoreDraftOnFailure,
    },
    sendAttempted: false,
  };
}

export function markOccupiedRecoveryForked(
  recovery: OccupiedSessionRecovery,
  forkSessionId: string,
): OccupiedSessionRecovery {
  return recovery.forkSessionId === forkSessionId && recovery.sendAttempted
    ? recovery
    : { ...recovery, forkSessionId, sendAttempted: true };
}

export function occupiedRecoveryMessageId(recovery: OccupiedSessionRecovery): string {
  return `occupied-recovery:${recovery.token}`;
}

export function isOccupiedRecoveryVisible(
  recovery: OccupiedSessionRecovery | undefined,
  sessionId: string | null | undefined,
): boolean {
  return Boolean(
    recovery
    && sessionId
    && (recovery.sourceSessionId === sessionId || recovery.forkSessionId === sessionId),
  );
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
    && isOccupiedSessionRecovery(summary.id, error);
}

export async function forkOccupiedCodexSession(options: {
  sourceSessionId: string;
  forkSession: (id: string) => Promise<UnifiedSessionSummary>;
  activateSession: (id: string) => void;
  refreshAndSelect: (session: UnifiedSessionSummary) => void | Promise<void>;
}): Promise<UnifiedSessionSummary> {
  const forked = await options.forkSession(options.sourceSessionId);
  options.activateSession(forked.id);
  await options.refreshAndSelect(forked);
  return forked;
}
