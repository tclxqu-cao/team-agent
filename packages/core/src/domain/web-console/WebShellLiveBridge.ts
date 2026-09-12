export const WEB_SHELL_OPEN_BROWSER_LIVE_TYPE = "agent-web-shell:open-browser-live:v1";

export interface WebShellOpenBrowserLiveMessage {
  type: typeof WEB_SHELL_OPEN_BROWSER_LIVE_TYPE;
}

export function parseWebShellOpenBrowserLive(data: unknown): WebShellOpenBrowserLiveMessage | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== WEB_SHELL_OPEN_BROWSER_LIVE_TYPE) return null;
  return { type: WEB_SHELL_OPEN_BROWSER_LIVE_TYPE };
}

export function readWebShellOpenBrowserLive(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  expectedOrigin: string,
  expectedSource: MessageEventSource | null,
): WebShellOpenBrowserLiveMessage | null {
  if (event.origin !== expectedOrigin || event.source !== expectedSource) return null;
  return parseWebShellOpenBrowserLive(event.data);
}
