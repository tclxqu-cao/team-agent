export interface SidebarSelection {
  projectId: string | null;
  sessionId: string | null;
}

export const EMPTY_SIDEBAR_SELECTION: SidebarSelection = {
  projectId: null,
  sessionId: null,
};

function normalizedId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function selectProject(projectId: string): SidebarSelection {
  return {
    projectId: normalizedId(projectId),
    sessionId: null,
  };
}

export function selectSession(
  projectId: string | null,
  sessionId: string,
): SidebarSelection {
  return {
    projectId: normalizedId(projectId),
    sessionId: normalizedId(sessionId),
  };
}

export function parseSidebarSelection(raw: string | null): SidebarSelection {
  if (!raw) return EMPTY_SIDEBAR_SELECTION;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return EMPTY_SIDEBAR_SELECTION;
    }
    const sessionId = normalizedId(parsed.sessionId);
    if (!sessionId) return EMPTY_SIDEBAR_SELECTION;
    return {
      projectId: normalizedId(parsed.projectId),
      sessionId,
    };
  } catch {
    return EMPTY_SIDEBAR_SELECTION;
  }
}

export function serializeSidebarSelection(selection: SidebarSelection): string | null {
  const sessionId = normalizedId(selection.sessionId);
  if (!sessionId) return null;
  return JSON.stringify({
    projectId: normalizedId(selection.projectId),
    sessionId,
  });
}
