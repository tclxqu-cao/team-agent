export const REMOTE_DESKTOP_VISIBILITY_TYPE = "agent-web-shell:remote-desktop-visibility:v1";
export const REMOTE_DESKTOP_CLOSE_TYPE = "agent-webapp:remote-desktop-close:v1";
export const REMOTE_DESKTOP_CONTENT_READY_TYPE = "agent-webapp:remote-desktop-content-ready:v1";

export function readRemoteDesktopVisibility(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  expectedOrigin: string,
  expectedSource: MessageEventSource | null,
): boolean | null {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) return null;
  const data = event.data as { type?: unknown; visible?: unknown } | null;
  return data?.type === REMOTE_DESKTOP_VISIBILITY_TYPE && typeof data.visible === "boolean"
    ? data.visible : null;
}
