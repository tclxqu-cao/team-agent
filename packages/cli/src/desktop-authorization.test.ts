import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { parseArgs } from "./args.js";
import { authorizeRemoteDesktop, runDesktopCommand, type DesktopAuthorizationContext, type DesktopAuthorizationStatus } from "./desktop-authorization.js";

// Never let an authorization regression reset the developer machine's TCC data.
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn((_file, _args, _options, callback) => callback(null, "", "")),
}));

const dataDir = "/tmp/remote-authorization-test";
function fixture(initial: Partial<DesktopAuthorizationStatus> = {}) {
  let status: DesktopAuthorizationStatus = { local: true, platform: "darwin", supported: true, installed: true,
    enabled: false, screen: false, accessibility: false, online: false, error: null, ...initial };
  const calls: unknown[] = [];
  const context: DesktopAuthorizationContext = {
    platform: "darwin", isTTY: true, input: null,
    log: vi.fn(), confirm: vi.fn(async () => true), wait: vi.fn(async () => {}), pollAttempts: 2,
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

describe("optional desktop authorization wizard", () => {
  beforeEach(() => { vi.mocked(execFile).mockClear(); });
  afterEach(() => expect(execFile).not.toHaveBeenCalled());

  it.each([
    { screen: false, accessibility: false },
    { screen: false, accessibility: true },
    { screen: true, accessibility: false },
  ])("preserves global macOS grants when this runtime reports %j", async (permissions) => {
    const f = fixture(permissions);
    expect(await authorizeRemoteDesktop(dataDir, f.context)).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
  });
  it("requests both OS permissions before enabling sharing, without pairing", async () => {
    const f = fixture();
    expect(await authorizeRemoteDesktop(dataDir, f.context)).toBe(true);
    expect(f.calls).toEqual([undefined, { action: "recheck" },
      { action: "request-permission", permission: "screen" },
      { action: "request-permission", permission: "accessibility" }, { action: "enable" }]);
    expect(f.context.log).toHaveBeenCalledWith(expect.stringContaining("授权完成"));
  });

  it("does not reset permissions or enable sharing when confirmation is declined", async () => {
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

  it("preserves an effective screen permission while repairing accessibility", async () => {
    const f = fixture({ screen: true });
    expect(await authorizeRemoteDesktop(dataDir, f.context)).toBe(true);
    expect(f.calls).not.toContainEqual({ action: "request-permission", permission: "screen" });
    expect(f.calls).toEqual([undefined, { action: "recheck" },
      { action: "request-permission", permission: "accessibility" }, { action: "enable" }]);
  });

  it("shows the installed application path and pending update before authorization", async () => {
    const f = fixture({ component: { name: 'AgentRoam Remote Desktop', path: '/Users/test/Library/Application Support/AgentRoamRemoteDesktop/Services.noindex/AgentRoam Remote Desktop.app', version: '0.2.0-preview.53', updatePending: true, pendingVersion: '0.2.0-preview.54' } });
    expect(await authorizeRemoteDesktop(dataDir, f.context)).toBe(true);
    expect(f.context.log).toHaveBeenCalledWith('远控组件：0.2.0-preview.53');
    expect(f.context.log).toHaveBeenCalledWith(expect.stringContaining('Services.noindex/AgentRoam Remote Desktop.app'));
    expect(f.context.log).toHaveBeenCalledWith(expect.stringContaining('结束其他 AgentRoam 的桌面共享'));
  });

  it("accepts Enter to skip in the terminal and releases the input for later pairing", async () => {
    const f = fixture();
    const input = new PassThrough();
    const listeners = process.listenerCount("SIGINT");
    f.context.log = vi.fn((line) => { if (line.includes("[y/N]")) input.write("\n"); });
    expect(await authorizeRemoteDesktop(dataDir, { ...f.context, input, confirm: undefined })).toBe(false);
    expect(f.calls).toEqual([undefined]);
    expect(input.destroyed).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    input.destroy();
  });

  it("accepts terminal confirmation without requiring an application dialog", async () => {
    const f = fixture({ screen: true, accessibility: true });
    const input = new PassThrough();
    f.context.log = vi.fn((line) => { if (line.includes("[y/N]")) input.write("y\n"); });
    expect(await authorizeRemoteDesktop(dataDir, { ...f.context, input, confirm: undefined })).toBe(true);
    expect(f.calls).toEqual([undefined, { action: "recheck" }, { action: "enable" }]);
    input.destroy();
  });

  it.each(["checking", "confirmation", "permission", "polling"])("applies one deadline even when %s never settles", async (phase) => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const request = f.context.request!;
      const stalled = (): Promise<never> => new Promise(() => {});
      f.context.request = vi.fn((directory, body, signal) => {
        if (phase === "checking" || (phase === "permission" && body?.action === "request-permission")) return stalled();
        if (phase === "polling" && body?.action === "request-permission") return Promise.resolve({ local: true, platform: "darwin", supported: true,
          installed: true, enabled: false, screen: false, accessibility: false, online: false, error: null });
        return request(directory, body, signal);
      });
      if (phase === "confirmation") f.context.confirm = stalled;
      if (phase === "polling") f.context.wait = stalled;
      const pending = authorizeRemoteDesktop(dataDir, { ...f.context, timeoutMs: 60_000 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await pending).toBe(false);
      expect(f.context.log).toHaveBeenCalledWith(expect.stringContaining("等待超时"));
      expect(f.calls).not.toContainEqual({ action: "enable" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("skips a hung permission request immediately and never enables sharing after a late reply", async () => {
    const f = fixture();
    const input = new PassThrough();
    const request = f.context.request!;
    let reply!: (status: DesktopAuthorizationStatus) => void;
    let started!: () => void;
    let activeSignal!: AbortSignal;
    const permissionStarted = new Promise<void>((resolve) => { started = resolve; });
    f.context.request = vi.fn((directory, body, signal) => {
      if (body?.action !== "request-permission") return request(directory, body, signal);
      activeSignal = signal!;
      started();
      return new Promise((resolve) => { reply = resolve; });
    });
    const pending = authorizeRemoteDesktop(dataDir, { ...f.context, input });
    await permissionStarted;
    input.write("s\n");
    expect(await pending).toBe(false);
    expect(activeSignal.aborted).toBe(true);
    reply({ local: true, platform: "darwin", supported: true, installed: true, enabled: false,
      screen: true, accessibility: true, online: false, error: null });
    await Promise.resolve();
    expect(f.calls).not.toContainEqual({ action: "enable" });
    input.destroy();
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
    const path = 'C:\\Users\\test\\AppData\\Local\\AgentRoam\\RemoteDesktop\\agentroam-remote-desktop.exe';
    const f = fixture({ platform: "win32", screen: true, accessibility: true, component: { name: 'AgentRoam Remote Desktop', path, version: '0.2.0-preview.57' } });
    expect(await authorizeRemoteDesktop(dataDir, { ...f.context, platform: "win32" })).toBe(true);
    expect(f.calls).toEqual([undefined, { action: "recheck" }, { action: "enable" }]);
    expect(f.context.log).toHaveBeenCalledWith(`组件位置：${path}`);
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
