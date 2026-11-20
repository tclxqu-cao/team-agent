export const WEB_SHELL_OPEN_TERMINAL_TYPE = "agent-web-shell:open-terminal:v1";
export const WEB_SHELL_NEW_TERMINAL_HASH = "#new-terminal";

export function webShellTerminalUrl(origin: string): string {
  return new URL(`/web${WEB_SHELL_NEW_TERMINAL_HASH}`, origin).href;
}

export interface WebShellOpenTerminalMessage {
  type: typeof WEB_SHELL_OPEN_TERMINAL_TYPE;
}

export function readWebShellOpenTerminal(
  event: Pick<MessageEvent, "data" | "origin" | "source">,
  expectedOrigin: string,
  expectedSource: MessageEventSource | null,
): WebShellOpenTerminalMessage | null {
  if (!expectedSource || event.origin !== expectedOrigin || event.source !== expectedSource) return null;
  return event.data?.type === WEB_SHELL_OPEN_TERMINAL_TYPE
    ? { type: WEB_SHELL_OPEN_TERMINAL_TYPE }
    : null;
}
