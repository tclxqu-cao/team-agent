export const WEBAPP_READY_MESSAGE_TYPE = "agent-webapp:ready:v1";

export interface WebappReadyMessage {
  type: typeof WEBAPP_READY_MESSAGE_TYPE;
}

export function parseWebappReadyMessage(data: unknown): WebappReadyMessage | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== WEBAPP_READY_MESSAGE_TYPE) return null;
  return { type: WEBAPP_READY_MESSAGE_TYPE };
}

export function readWebappReadyMessage(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  expectedOrigin: string,
  expectedSource: MessageEventSource | null,
): WebappReadyMessage | null {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) return null;
  return parseWebappReadyMessage(event.data);
}
