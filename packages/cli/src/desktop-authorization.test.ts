import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "./args.js";
import { authorizeRemoteDesktop, runDesktopCommand, type DesktopAuthorizationContext, type DesktopAuthorizationStatus } from "./desktop-authorization.js";

const dataDir = "/tmp/remote-authorization-test";
function fixture(initial: Partial<DesktopAuthorizationStatus> = {}) {
  let status: DesktopAuthorizationStatus = { local: true, platform: "darwin", supported: true, installed: true,
    enabled: false, screen: false, accessibility: false, online: false, error: null, ...initial };
  const calls: unknown[] = [];
  const context: DesktopAuthorizationContext = {
    platform: "darwin", isTTY: true, log: vi.fn(), confirm: vi.fn(async () => true), wait: vi.fn(async () => {}), pollAttempts: 2,
    request: vi.fn(async (_directory, body) => {
      calls.push(body);
      if (body?.action === "request-permission") status = { ...status, [body.permission!]: true };
      if (body?.action === "enable") status = { ...status, enabled: true, online: true, error: null };
      if (body?.action === "disable") status = { ...status, enabled: false, online: false };
      return { ...status };
    }),
  };
  return { context, calls };
}

describe("native desktop authorization wizard", () => {
  it("requests both OS permissions before enabling sharing, without pairing", async () => {
    const f = fixture();
    expect(await authorizeRemoteDesktop(dataDir, f.context)).toBe(true);
    expect(f.calls).toEqual([undefined, { action: "recheck" },
      { action: "request-permission", permission: "screen" },
      { action: "request-permission", permission: "accessibility" }, { action: "enable" }]);
    expect(f.context.log).toHaveBeenCalledWith(expect.stringContaining("授权完成"));
  });

  it("does not change sharing or request permissions when the native dialog is cancelled", async () => {
    const f = fixture();
    f.context.confirm = vi.fn(async () => false);
    expect(await authorizeRemoteDesktop(dataDir, f.context)).toBe(false);
    expect(f.calls).toEqual([undefined]);
    expect(f.context.log).toHaveBeenCalledWith(expect.stringContaining("agentroam desktop authorize"));
  });

  it("never requests permission or reads piped input in unattended installations", async () => {
    const f = fixture();
    expect(await authorizeRemoteDesktop(dataDir, { ...f.context, isTTY: false })).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.context.confirm).not.toHaveBeenCalled();
  });

  it("keeps an already authorized installation without another dialog", async () => {
    const f = fixture({ enabled: true, screen: true, accessibility: true });
    expect(await authorizeRemoteDesktop(dataDir, f.context)).toBe(true);
    expect(f.calls).toEqual([undefined, { action: "recheck" }]);
    expect(f.context.confirm).not.toHaveBeenCalled();
  });

  it("enables sharing with existing OS permissions after confirmation", async () => {
    const f = fixture({ screen: true, accessibility: true });
    expect(await authorizeRemoteDesktop(dataDir, f.context)).toBe(true);
    expect(f.calls).toEqual([undefined, { action: "recheck" }, { action: "enable" }]);
    expect(f.context.confirm).toHaveBeenCalledOnce();
  });

  it.each(["screen", "accessibility"] as const)("does not enable sharing when %s is denied or times out", async (permission) => {
    const f = fixture();
    f.context.request = vi.fn(async (_directory, body) => {
      f.calls.push(body);
      return { local: true, platform: "darwin", supported: true, installed: true, enabled: false, online: false,
        screen: permission !== "screen", accessibility: false, error: null };
    });
    expect(await authorizeRemoteDesktop(dataDir, f.context)).toBe(false);
    expect(f.context.wait).toHaveBeenCalledTimes(2);
    expect(f.calls).not.toContainEqual({ action: "enable" });
    expect(f.context.log).toHaveBeenCalledWith(expect.stringContaining("未开启共享"));
  });

  it("rechecks permissions after the user finishes in system settings", async () => {
    const f = fixture();
    const request = vi.fn()
      .mockResolvedValueOnce({ supported: true, installed: true, enabled: false })
      .mockResolvedValueOnce({ screen: false, accessibility: true })
      .mockResolvedValueOnce({ screen: false, accessibility: true })
      .mockResolvedValueOnce({ screen: true, accessibility: true })
      .mockResolvedValueOnce({ enabled: true, screen: true, accessibility: true, error: null });
    expect(await authorizeRemoteDesktop(dataDir, { ...f.context, request })).toBe(true);
    expect(f.context.wait).toHaveBeenCalledOnce();
    expect(request.mock.calls.map(([, body]) => body?.action)).toEqual([undefined, "recheck", "request-permission", "recheck", "enable"]);
  });

  it("reports failed activation even when the HTTP operation succeeded", async () => {
    const f = fixture({ screen: true, accessibility: true });
    f.context.request = vi.fn(async () => ({ local: true, platform: "darwin", supported: true, installed: true,
      screen: true, accessibility: true, enabled: false, online: false, error: "helper failed" }));
    await expect(authorizeRemoteDesktop(dataDir, f.context)).rejects.toThrow("helper failed");
    expect(f.context.log).not.toHaveBeenCalledWith(expect.stringContaining("授权完成"));
  });

  it.each([{ supported: false }, { installed: false }])("rejects unavailable components before confirmation", async (status) => {
    const f = fixture(status);
    await expect(authorizeRemoteDesktop(dataDir, f.context)).rejects.toThrow();
    expect(f.context.confirm).not.toHaveBeenCalled();
  });

  it("enables an available Windows desktop without macOS permission requests", async () => {
    const f = fixture({ platform: "win32", screen: true, accessibility: true });
    expect(await authorizeRemoteDesktop(dataDir, { ...f.context, platform: "win32" })).toBe(true);
    expect(f.calls).toEqual([undefined, { action: "recheck" }, { action: "enable" }]);
  });

  it("reports an unavailable Windows desktop without enabling sharing", async () => {
    const f = fixture({ platform: "win32" });
    expect(await authorizeRemoteDesktop(dataDir, { ...f.context, platform: "win32" })).toBe(false);
    expect(f.calls).toEqual([undefined, { action: "recheck" }]);
  });

  it("status rechecks actual permissions without requesting or enabling them", async () => {
    const f = fixture();
    await runDesktopCommand(parseArgs(["desktop", "status"]), f.context);
    expect(f.calls).toEqual([undefined, { action: "recheck" }]);
    expect(f.context.confirm).not.toHaveBeenCalled();
  });

  it("disable preserves OS permissions and closes sharing", async () => {
    const f = fixture({ enabled: true, screen: true, accessibility: true });
    await runDesktopCommand(parseArgs(["desktop", "disable"]), f.context);
    expect(f.calls).toEqual([undefined, { action: "disable" }]);
    expect(f.context.log).toHaveBeenCalledWith(expect.stringContaining("系统权限保留"));
  });
});
