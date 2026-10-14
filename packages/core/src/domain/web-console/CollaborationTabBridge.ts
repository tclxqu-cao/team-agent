export const COLLABORATION_CHANGED_TYPE =
  "agent-webapp:collaboration-changed:v1";
export const COLLABORATION_OPEN_TYPE = "agent-webapp:collaboration-open:v1";
export const COLLABORATION_CONTENT_READY_TYPE =
  "agent-webapp:collaboration-content-ready:v1";
export const COLLABORATION_DASHBOARD_READY_TYPE =
  "agent-webapp:collaboration-dashboard-ready:v1";
export const COLLABORATION_CREATE_TYPE =
  "agent-web-shell:collaboration-create:v1";

export function readCollaborationCreate(
  event: Pick<MessageEvent, "data" | "source" | "origin">,
  origin: string,
  parent: MessageEventSource | null,
): boolean {
  if (!parent || event.source !== parent || event.origin !== origin)
    return false;
  const data: unknown = event.data;
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).type === COLLABORATION_CREATE_TYPE
  );
}

export function readCollaborationOpen(
  event: Pick<MessageEvent, "data" | "source" | "origin">,
  origin: string,
  source: MessageEventSource | null,
): { groupId: string; title: string } | null {
  if (!source || event.source !== source || event.origin !== origin)
    return null;
  const data = event.data as Record<string, unknown> | null;
  return data?.type === COLLABORATION_OPEN_TYPE &&
    typeof data.groupId === "string" &&
    /^[a-zA-Z0-9_-]{1,100}$/.test(data.groupId) &&
    typeof data.title === "string" &&
    data.title.length > 0 &&
    data.title.length <= 100
    ? { groupId: data.groupId, title: data.title }
    : null;
}

/** Only the dashboard frame may report completed group mutations. */
export function readCollaborationChanged(
  event: Pick<MessageEvent, "data" | "source" | "origin">,
  origin: string,
  source: MessageEventSource | null,
): { groupId: string; title?: string; deleted?: true } | null {
  if (!source || event.source !== source || event.origin !== origin)
    return null;
  const data = event.data as Record<string, unknown> | null;
  if (
    data?.type !== COLLABORATION_CHANGED_TYPE ||
    typeof data.groupId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(data.groupId)
  )
    return null;
  if (data.deleted === true) return { groupId: data.groupId, deleted: true };
  return typeof data.title === "string" &&
    data.title.length > 0 &&
    data.title.length <= 100
    ? { groupId: data.groupId, title: data.title }
    : null;
}

/** Readiness belongs to the current view's frame, not the iframe document load event. */
export function readCollaborationContentReady(
  event: Pick<MessageEvent, "data" | "source" | "origin">,
  origin: string,
  source: MessageEventSource | null,
  groupId: string | null,
): boolean {
  if (!source || event.source !== source || event.origin !== origin) return false;
  const data: unknown = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const message = data as Record<string, unknown>;
  return groupId === null
    ? message.type === COLLABORATION_DASHBOARD_READY_TYPE
    : message.type === COLLABORATION_CONTENT_READY_TYPE && message.groupId === groupId;
}
