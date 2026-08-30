export const WEBAPP_TAB_SWIPE_MESSAGE_TYPE = "agent-webapp:tab-swipe:v1";

export interface WebappTabSwipeMessage {
  type: typeof WEBAPP_TAB_SWIPE_MESSAGE_TYPE;
  phase: "move" | "end" | "cancel";
  deltaX: number;
}

export function parseWebappTabSwipeMessage(data: unknown): WebappTabSwipeMessage | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== WEBAPP_TAB_SWIPE_MESSAGE_TYPE) return null;
  if (candidate.phase !== "move" && candidate.phase !== "end" && candidate.phase !== "cancel") return null;
  if (typeof candidate.deltaX !== "number" || !Number.isFinite(candidate.deltaX)) return null;
  return candidate as unknown as WebappTabSwipeMessage;
}

export function readWebappTabSwipeMessage(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  expectedOrigin: string,
  expectedSource: MessageEventSource | null,
): WebappTabSwipeMessage | null {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) return null;
  return parseWebappTabSwipeMessage(event.data);
}
