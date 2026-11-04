/** Shared UI announces readiness only after the message page has mounted. */
export const MESSAGING_READY = "agentroam:messaging-ready:v1";
export const MESSAGING_OPEN = "agentroam:messaging-open:v1";
export const MESSAGING_OPEN_QUERY = "openTab";

/** Only the same-origin assistant frame may open the shell's messaging tab. */
export function readMessagingOpen(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  origin: string,
  source: MessageEventSource | null,
): boolean {
  if (!source || event.source !== source || event.origin !== origin) return false;
  const data: unknown = event.data;
  return !!data && typeof data === "object" && !Array.isArray(data)
    && (data as Record<string, unknown>).type === MESSAGING_OPEN;
}
