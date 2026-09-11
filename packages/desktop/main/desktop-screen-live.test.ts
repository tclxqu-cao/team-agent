import { describe, expect, it, vi } from "vitest";
import { DESKTOP_LIVE_SESSION_ID, DesktopScreenLive, type DesktopLiveStatus } from "./desktop-screen-live";
import type { LiveViewOwnershipState } from "@agent/core";

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  frame: ReturnType<typeof vi.fn>;
  state: ReturnType<typeof vi.fn>;
  unavailable: ReturnType<typeof vi.fn>;
  waitForDisconnect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue({ channelId: 3 }),
    onEvent: vi.fn(() => () => undefined),
    frame: vi.fn().mockResolvedValue({ accepted: true }),
    state: vi.fn().mockResolvedValue(undefined),
    unavailable: vi.fn().mockResolvedValue(undefined),
    waitForDisconnect: vi.fn(() => new Promise<void>(() => {})),
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    ...overrides,
  };
}

function fakeGateway() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    checkAccessibility: vi.fn().mockResolvedValue(true),
    dispatch: vi.fn().mockResolvedValue(undefined),
  };
}

const runningScreencast = {
  start: vi.fn(() => new Promise<void>(() => {})),
  stop: vi.fn().mockResolvedValue(undefined),
  dispatchInput: vi.fn().mockResolvedValue(undefined),
};

async function tick(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("DesktopScreenLive", () => {
  it("refuses to start when screen recording permission is missing", async () => {
    const gateway = fakeGateway();
    const live = new DesktopScreenLive({
      clientFactory: () => fakeClient(),
      screencast: runningScreencast,
      input: gateway as never,
      probeScreen: () => "denied",
    });
    const status = await live.enable();
    expect(status.enabled).toBe(true);
    expect(status.permissionScreen).toBe("denied");
    expect(status.error).toContain("屏幕录制");
    expect(gateway.start).not.toHaveBeenCalled();
    await live.disable();
  });

  it("wakes and holds the display while enabled, releasing on disable", async () => {
    const gateway = fakeGateway();
    const keepAwake = { start: vi.fn(), stop: vi.fn() };
    const live = new DesktopScreenLive({
      clientFactory: () => fakeClient(),
      screencast: runningScreencast,
      input: gateway as never,
      probeScreen: () => "granted",
      probeAccessibility: async () => true,
      keepAwake,
    });
    await live.enable();
    expect(keepAwake.start).toHaveBeenCalledTimes(1);
    await live.disable();
    expect(keepAwake.stop).toHaveBeenCalledTimes(1);
  });

  it("does not hold the display awake when the live source is unavailable", async () => {
    const gateway = fakeGateway();
    const keepAwake = { start: vi.fn(), stop: vi.fn() };
    const live = new DesktopScreenLive({
      clientFactory: () => fakeClient(),
      screencast: runningScreencast,
      input: gateway as never,
      probeScreen: () => "denied",
      keepAwake,
    });
    await live.enable();
    expect(keepAwake.start).not.toHaveBeenCalled();
    await live.disable();
  });

  it("publishes a desktop session and relays ownership state", async () => {
    const gateway = fakeGateway();
    const client = fakeClient();
    const listenerRef: { current: ((event: Record<string, unknown>) => void) | null } = { current: null };
    client.onEvent.mockImplementation((listener: (event: Record<string, unknown>) => void) => {
      // The coordinator subscribes before the producer does; keep the first (coordinator) listener.
      if (!listenerRef.current) listenerRef.current = listener;
      return () => undefined;
    });
    const statuses: DesktopLiveStatus[] = [];
    const live = new DesktopScreenLive({
      clientFactory: () => client,
      screencast: runningScreencast,
      input: gateway as never,
      probeScreen: () => "granted",
      probeAccessibility: async () => true,
    });
    live.onStatus((status) => statuses.push(status));
    const status = await live.enable();
    await tick();
    expect(client.publish).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: DESKTOP_LIVE_SESSION_ID,
      backend: "desktop",
      title: "桌面屏幕",
      state: "agent-controlled",
    }));
    expect(status.accessibilityTrusted).toBe(true);
    expect(status.sessionOnline).toBe(true);
    expect(status.controlState).toBeNull();

    listenerRef.current?.({ type: "browser:state", session: { id: DESKTOP_LIVE_SESSION_ID, state: "user-controlled" as LiveViewOwnershipState } });
    expect(live.getStatus().controlState).toBe("user-controlled");

    await live.disable();
    expect(gateway.stop).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledWith(DESKTOP_LIVE_SESSION_ID);
    expect(live.getStatus().enabled).toBe(false);
  });

  it("keeps the stream watchable but flags the missing accessibility grant", async () => {
    const gateway = fakeGateway();
    const live = new DesktopScreenLive({
      clientFactory: () => fakeClient(),
      screencast: runningScreencast,
      input: gateway as never,
      probeScreen: () => "granted",
      probeAccessibility: async () => false,
    });
    const status = await live.enable();
    await tick();
    expect(status.accessibilityTrusted).toBe(false);
    expect(status.error).toContain("辅助功能");
    expect(status.sessionOnline).toBe(true);
    await live.disable();
  });

  it("reports the screencast failure through status and keeps the gateway stopped on disable", async () => {
    const gateway = fakeGateway();
    const failingScreencast = {
      start: vi.fn().mockRejectedValue(Object.assign(new Error("no capture source"), { code: "BROWSER_LIVE_STREAM_UNAVAILABLE" })),
      stop: vi.fn().mockResolvedValue(undefined),
      dispatchInput: vi.fn().mockResolvedValue(undefined),
    };
    const client = fakeClient();
    const live = new DesktopScreenLive({
      clientFactory: () => client,
      screencast: failingScreencast,
      input: gateway as never,
      probeScreen: () => "granted",
      probeAccessibility: async () => true,
    });
    await live.enable();
    await tick();
    expect(live.getStatus().error).toContain("no capture source");
    await live.disable();
    expect(live.getStatus().error).toBeUndefined();
  });
});
