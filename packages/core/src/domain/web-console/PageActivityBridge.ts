export const PAGE_ACTIVITY = "agentroam:page-activity:v1";
export const PAGE_ACTIVITY_REQUEST = "agentroam:page-activity-request:v1";

export function readPageActivity(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  origin: string,
  parent: MessageEventSource | null,
): boolean | null {
  if (!parent || event.source !== parent || event.origin !== origin
    || event.data?.type !== PAGE_ACTIVITY || typeof event.data.active !== "boolean") return null;
  return event.data.active;
}
