import { afterEach, describe, expect, it, vi } from "vitest";
import { newSessionWindowUrl, openNewSessionWindow, readNewSessionWindow } from "./new-session-window";

afterEach(() => vi.unstubAllGlobals());

describe("new session window navigation", () => {
  it("does not treat ordinary new-session navigation as a separate window", () => {
    expect(readNewSessionWindow("?newSession=1&agent=codex")).toBeNull();
  });

  it("keeps the requested Agent and directory, including special characters", () => {
    const options = { agentType: "codex" as const, workspacePath: "/project/中文 & test/#folder" };
    const url = new URL(newSessionWindowUrl("http://localhost:3000/app/?session=old&view=calendar#old", options));
    expect(url.pathname).toBe("/app/");
    expect(readNewSessionWindow(url.search)).toEqual(options);
    expect(url.searchParams.has("session")).toBe(false);
    expect(url.searchParams.has("view")).toBe(false);
    expect(url.hash).toBe("");
  });

  it("validates the Agent before initializing the composer", () => {
    expect(readNewSessionWindow("?newSessionWindow=1&agent=invalid")).toEqual({ agentType: "customer-agent" });
  });

  it("uses the trusted native window bridge when available", async () => {
    const native = vi.fn().mockResolvedValue(undefined);
    const open = vi.fn();
    vi.stubGlobal("window", { agentApi: { openNewSessionWindow: native }, open });
    await openNewSessionWindow({ agentType: "zcode", workspacePath: "/repo" });
    expect(native).toHaveBeenCalledWith({ agentType: "zcode", workspacePath: "/repo" });
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the browser popup during the click and detaches its opener", async () => {
    const popup = { opener: {}, focus: vi.fn() };
    const open = vi.fn().mockReturnValue(popup);
    vi.stubGlobal("window", { agentApi: {}, location: { href: "http://localhost:3000/app/?session=old" }, open });
    const result = openNewSessionWindow({ agentType: "codex" });
    expect(open).toHaveBeenCalledTimes(1);
    await result;
    expect(popup.opener).toBeNull();
    expect(popup.focus).toHaveBeenCalledOnce();
  });

  it("reports popup blocking without changing the current page", async () => {
    const location = { href: "http://localhost:3000/app/?session=old" };
    vi.stubGlobal("window", { agentApi: {}, location, open: vi.fn().mockReturnValue(null) });
    await expect(openNewSessionWindow({ agentType: "codex" })).rejects.toThrow("允许弹出窗口");
    expect(location.href).toBe("http://localhost:3000/app/?session=old");
  });
});
