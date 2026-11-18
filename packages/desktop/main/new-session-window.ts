import { randomUUID } from "node:crypto";
import { isAgentType } from "@agent/core";
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";

export function newSessionWindowQuery(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") throw new Error("Invalid new session window options");
  const options = value as { agentType?: unknown; workspacePath?: unknown };
  if (!isAgentType(options.agentType)) throw new Error("Invalid new session agent");
  if (options.workspacePath !== undefined && (typeof options.workspacePath !== "string"
    || options.workspacePath.length > 32768 || options.workspacePath.includes("\0"))) {
    throw new Error("Invalid new session directory");
  }
  return {
    newSessionWindow: "1",
    agent: options.agentType,
    ...(typeof options.workspacePath === "string" && options.workspacePath ? { cwd: options.workspacePath } : {}),
  };
}

/** Only app-owned renderer main frames share the broker; each owns its SSE handles. */
export class DesktopRendererWindows {
  private readonly windows = new Map<WebContents, { window: BrowserWindow; streams: Map<string, string> }>();

  constructor(private readonly stop: (id: string) => void) {}

  register(window: BrowserWindow): void {
    const contents = window.webContents;
    if (this.windows.has(contents)) return;
    const streams = new Map<string, string>();
    this.windows.set(contents, { window, streams });
    window.once("closed", () => {
      this.windows.delete(contents);
      for (const id of streams.values()) this.stop(id);
      streams.clear();
    });
  }

  assertSender(event: IpcMainInvokeEvent): void {
    if (!this.windows.has(event.sender) || event.sender.isDestroyed()
      || event.senderFrame !== event.sender.mainFrame) throw new Error("Untrusted desktop sender");
  }

  streamId(event: IpcMainInvokeEvent, id: string): string {
    this.assertSender(event);
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid stream request");
    const { streams } = this.windows.get(event.sender)!;
    let internalId = streams.get(id);
    if (!internalId) { internalId = randomUUID(); streams.set(id, internalId); }
    return internalId;
  }

  stopStream(event: IpcMainInvokeEvent, id: string): void {
    this.assertSender(event);
    const { streams } = this.windows.get(event.sender)!;
    const internalId = streams.get(id);
    if (internalId) { streams.delete(id); this.stop(internalId); }
  }
}
