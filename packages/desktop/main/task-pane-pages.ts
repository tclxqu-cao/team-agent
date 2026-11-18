import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { AIHubManager } from "./ai-hub/manager.js";

export function taskPanePageId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? `task-pane-${value}` : null;
}

export function taskPanePageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

export function taskPanePageRect(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!value || typeof value !== "object") return null;
  const rect = value as Record<string, unknown>;
  if (![rect.x, rect.y, rect.width, rect.height].every(item => typeof item === "number" && Number.isFinite(item))) return null;
  if ((rect.width as number) <= 0 || (rect.height as number) <= 0) return null;
  return { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number };
}

/** Native website panes never receive Node integration or access to the host renderer's IPC. */
export function registerTaskPanePageIpc(ipc: IpcMain, manager: AIHubManager, getWindow: () => BrowserWindow | null): void {
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    return Boolean(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
  };
  ipc.handle("task-page:open", async (event, rawId: unknown, rawUrl: unknown) => {
    const id = taskPanePageId(rawId), url = taskPanePageUrl(rawUrl);
    if (!trusted(event) || !id || !url) return { ok: false };
    try { await manager.openEmbeddedPage(id, url, { allowMedia: false }); return { ok: true }; } catch { return { ok: false }; }
  });
  ipc.handle("task-page:set-bounds", (event, rawId: unknown, rawRect: unknown) => {
    const id = taskPanePageId(rawId);
    if (!trusted(event) || !id) return { ok: false };
    const rect = rawRect === null ? null : taskPanePageRect(rawRect);
    if (rawRect !== null && !rect) return { ok: false };
    manager.setEmbeddedPageBounds(id, rect);
    return { ok: true };
  });
  ipc.handle("task-page:reload", (event, rawId: unknown) => {
    const id = taskPanePageId(rawId);
    if (!trusted(event) || !id) return { ok: false };
    manager.reloadEmbeddedPage(id);
    return { ok: true };
  });
  ipc.handle("task-page:close", (event, rawId: unknown) => {
    const id = taskPanePageId(rawId);
    if (!trusted(event) || !id) return { ok: false };
    manager.closeEmbeddedPage(id);
    return { ok: true };
  });
}
