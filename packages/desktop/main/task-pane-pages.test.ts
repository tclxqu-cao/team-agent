import { describe, expect, it, vi } from "vitest";
import { registerTaskPanePageIpc, taskPanePageId, taskPanePageRect, taskPanePageUrl } from "./task-pane-pages";

describe("task pane native website boundaries", () => {
  it("accepts only pane identifiers, http URLs and finite visible bounds", () => {
    expect(taskPanePageId("a-b_123")).toBe("task-pane-a-b_123");
    expect(taskPanePageId("../flow-studio")).toBeNull();
    expect(taskPanePageId("")).toBeNull();
    expect(taskPanePageUrl("https://example.com")).toBe("https://example.com/");
    expect(taskPanePageUrl("javascript:alert(1)")).toBeNull();
    expect(taskPanePageUrl("file:///tmp/test")).toBeNull();
    expect(taskPanePageRect({ x: 10, y: 20, width: 300, height: 500 })).toEqual({ x: 10, y: 20, width: 300, height: 500 });
    expect(taskPanePageRect({ x: 0, y: 0, width: Infinity, height: 20 })).toBeNull();
    expect(taskPanePageRect({ x: 0, y: 0, width: 0, height: 20 })).toBeNull();
  });

  it("isolates pane open, hide, reload and disposal from untrusted frames", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const ipc = { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) };
    const manager = { openEmbeddedPage: vi.fn().mockResolvedValue(undefined), setEmbeddedPageBounds: vi.fn(), reloadEmbeddedPage: vi.fn(), closeEmbeddedPage: vi.fn() };
    const mainFrame = {};
    const webContents = { mainFrame };
    registerTaskPanePageIpc(ipc as never, manager as never, () => ({ webContents }) as never);
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, ...args);
    expect(await invoke("task-page:open", "left", "https://example.com")).toEqual({ ok: true });
    expect(manager.openEmbeddedPage).toHaveBeenCalledWith("task-pane-left", "https://example.com/", { allowMedia: false });
    invoke("task-page:set-bounds", "left", null);
    expect(manager.setEmbeddedPageBounds).toHaveBeenCalledWith("task-pane-left", null);
    invoke("task-page:reload", "left");
    expect(manager.reloadEmbeddedPage).toHaveBeenCalledWith("task-pane-left");
    invoke("task-page:close", "left");
    expect(manager.closeEmbeddedPage).toHaveBeenCalledWith("task-pane-left");
    expect(await handlers.get("task-page:open")!({ sender: webContents, senderFrame: {} }, "left", "https://example.com")).toEqual({ ok: false });
    expect(await invoke("task-page:open", "left", "file:///tmp/test")).toEqual({ ok: false });
    expect(manager.openEmbeddedPage).toHaveBeenCalledTimes(1);
  });
});
