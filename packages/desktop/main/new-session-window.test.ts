import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { DesktopRendererWindows, newSessionWindowQuery } from "./new-session-window";

function renderer() {
  const closed = new Set<() => void>();
  const webContents = { mainFrame: {}, isDestroyed: () => false };
  const window = { webContents, once: (name: string, listener: () => void) => { if (name === "closed") closed.add(listener); } };
  return {
    window: window as unknown as BrowserWindow,
    event: { sender: webContents, senderFrame: webContents.mainFrame } as unknown as IpcMainInvokeEvent,
    close: () => closed.forEach(listener => listener()),
  };
}

describe("new session desktop windows", () => {
  it("preserves agent and directory when encoded for a renderer URL", () => {
    const cwd = "/Users/test/客户 & query?agent=claude-code#work";
    const query = newSessionWindowQuery({ agentType: "codex", workspacePath: cwd });
    const parsed = new URL(`http://localhost:5173/?${new URLSearchParams(query)}`).searchParams;
    expect(parsed.get("newSessionWindow")).toBe("1");
    expect(parsed.get("agent")).toBe("codex");
    expect(parsed.get("cwd")).toBe(cwd);
    expect(newSessionWindowQuery({ agentType: "customer-agent" }).cwd).toBeUndefined();
    expect(() => newSessionWindowQuery({ agentType: "invalid" })).toThrow("Invalid new session agent");
    expect(() => newSessionWindowQuery({ agentType: "codex", workspacePath: 123 })).toThrow("Invalid new session directory");
    expect(() => newSessionWindowQuery({ agentType: "codex", workspacePath: "bad\0path" })).toThrow("Invalid new session directory");
  });

  it("allows only registered renderer main frames and revokes them on close", () => {
    const registry = new DesktopRendererWindows(vi.fn());
    const main = renderer(), composer = renderer(), unrelated = renderer();
    registry.register(main.window);
    registry.register(composer.window);
    expect(() => registry.assertSender(main.event)).not.toThrow();
    expect(() => registry.assertSender(composer.event)).not.toThrow();
    expect(() => registry.assertSender(unrelated.event)).toThrow("Untrusted desktop sender");
    expect(() => registry.assertSender({ ...composer.event, senderFrame: {} } as never)).toThrow("Untrusted desktop sender");
    composer.close();
    expect(() => registry.assertSender(composer.event)).toThrow("Untrusted desktop sender");
    expect(() => registry.assertSender(main.event)).not.toThrow();
  });

  it("isolates identical stream IDs across windows and closes only the owner's streams", () => {
    const stop = vi.fn();
    const registry = new DesktopRendererWindows(stop);
    const main = renderer(), composer = renderer();
    registry.register(main.window);
    registry.register(composer.window);
    const mainId = registry.streamId(main.event, "same-id");
    const composerId = registry.streamId(composer.event, "same-id");
    expect(mainId).not.toBe(composerId);
    expect(registry.streamId(composer.event, "same-id")).toBe(composerId);
    expect(() => registry.streamId(composer.event, "../invalid")).toThrow("Invalid stream request");
    registry.stopStream(composer.event, "unknown-id");
    expect(stop).not.toHaveBeenCalled();
    composer.close();
    expect(stop.mock.calls).toEqual([[composerId]]);
    registry.stopStream(main.event, "same-id");
    expect(stop.mock.calls).toEqual([[composerId], [mainId]]);
    main.close();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
