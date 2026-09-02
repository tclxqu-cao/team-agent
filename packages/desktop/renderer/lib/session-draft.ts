const DRAFT_PREFIX = "agentroam:draft:";

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
