import { describe, expect, it, vi } from "vitest";
import { DesktopLiveCliProxy, mapRemoteAuthorizationStatus } from "./desktop-live-cli-proxy";

describe("DesktopLiveCliProxy", () => {
  it("maps CLI remote authorization state to the Desktop API contract", () => {
    expect(mapRemoteAuthorizationStatus({
      platform: "darwin",
      supported: true,
      installed: true,
      enabled: true,
      screen: true,
      accessibility: true,
      online: true,
      locked: true,
      viewerCount: 2,
      controlState: "user-controlled",
    })).toEqual({
      platform: "darwin",
      supported: true,
      installed: true,
      enabled: true,
      permissionScreen: "granted",
      accessibilityTrusted: true,
      sessionOnline: true,
      locked: true,
      viewerCount: 2,
      controlState: "user-controlled",
    });
  });

  it("forwards actions to the CLI and reports status changes", async () => {
    const onStatus = vi.fn();
    const request = vi.fn(async (_path: string, _method: string, body?: string) => ({
      status: 200,
      body: JSON.stringify({
        platform: "darwin", supported: true, installed: true,
        enabled: JSON.parse(body ?? "{}").action !== "disable",
        screen: true, accessibility: true, online: true,
      }),
    }));
    const proxy = new DesktopLiveCliProxy({ request, onStatus });

    await expect(proxy.action("enable")).resolves.toMatchObject({ enabled: true, permissionScreen: "granted" });
    expect(request).toHaveBeenCalledWith("/api/remote-authorization", "POST", JSON.stringify({ action: "enable" }));
    expect(onStatus).toHaveBeenCalledTimes(1);
    await proxy.refresh();
    expect(request).toHaveBeenLastCalledWith("/api/remote-authorization", "GET", undefined);
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("prepares the local desktop payload before a reused CLI checks or requests permissions", async () => {
    const calls: string[] = [];
    const proxy = new DesktopLiveCliProxy({
      prepareRemoteComponent: async permission => { calls.push(`prepare ${permission ?? "component"}`); },
      request: async (_path, method, body) => {
        const action = body ? JSON.parse(body) : {};
        calls.push([method, action.action, action.permission].filter(Boolean).join(" "));
        return { status: 200, body: "{}" };
      },
    });
    await proxy.refresh();
    await proxy.action("recheck");
    await proxy.action("authorize", "screen");
    await proxy.action("enable");
    await proxy.action("disable");
    expect(calls).toEqual(["GET", "prepare component", "POST recheck", "prepare screen", "POST authorize screen", "prepare component", "POST enable", "POST disable"]);
  });

  it("coalesces concurrent polls and surfaces CLI errors", async () => {
    let release!: (value: { status: number; body: string }) => void;
    const request = vi.fn(() => new Promise<{ status: number; body: string }>((resolve) => { release = resolve; }));
    const proxy = new DesktopLiveCliProxy({ request });
    const first = proxy.refresh();
    const second = proxy.refresh();
    expect(request).toHaveBeenCalledTimes(1);
    release({ status: 503, body: JSON.stringify({ error: "远程组件不可用" }) });
    await expect(first).rejects.toThrow("远程组件不可用");
    await expect(second).rejects.toThrow("远程组件不可用");
  });
});
