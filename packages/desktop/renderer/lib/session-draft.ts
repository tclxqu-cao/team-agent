const DRAFT_PREFIX = "agentroam:draft:";

export type SessionDraftAction =
  | { type: "inactive"; ownerSessionId: null }
  | { type: "restore"; ownerSessionId: string }
  | { type: "persist"; ownerSessionId: string; value: string };

function key(sessionId: string): string {
  return `${DRAFT_PREFIX}${sessionId}`;
}

export function readSessionDraft(sessionId: string | null | undefined): string {
  if (!sessionId || typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(key(sessionId)) ?? "";
  } catch {
    return "";
  }
}

export function writeSessionDraft(sessionId: string | null | undefined, value: string): void {
  if (!sessionId || typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(key(sessionId), value);
    else window.localStorage.removeItem(key(sessionId));
  } catch {
    // Storage can be unavailable in private or embedded browser contexts.
  }
}

export function clearSessionDraft(sessionId: string | null | undefined): void {
  if (!sessionId || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key(sessionId));
  } catch {
    // Keep the visible draft when storage cleanup is unavailable.
  }
}

export function resolveSessionDraftAction(
  ownerSessionId: string | null,
  viewedSessionId: string | null | undefined,
  value: string,
): SessionDraftAction {
  if (!viewedSessionId) return { type: "inactive", ownerSessionId: null };
  if (ownerSessionId !== viewedSessionId) {
    return { type: "restore", ownerSessionId: viewedSessionId };
  }
  return { type: "persist", ownerSessionId: viewedSessionId, value };
}
