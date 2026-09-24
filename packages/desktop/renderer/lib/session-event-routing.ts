export function resolveSessionEventTarget(eventSessionId: unknown): string | null {
  return typeof eventSessionId === "string" && eventSessionId.trim().length > 0
    ? eventSessionId
    : null;
}
