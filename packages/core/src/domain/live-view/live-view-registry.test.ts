import { describe, expect, it } from "vitest";
import { LiveViewRegistry } from "./live-view-registry";
import type { LiveViewEvent, LiveViewPeer } from "./entities";

function peer(id: string): LiveViewPeer & { messages: LiveViewEvent[] } {
  const messages: LiveViewEvent[] = [];
  return { id, userId: "local", messages, send: (message) => messages.push(message), producerSessionIds: new Set(), watchedSessionId: null };
}

function publish(registry: LiveViewRegistry, producer: LiveViewPeer, availability: "starting" | "ready" | "unavailable" = "ready") {
  return registry.publish(producer, { sessionId: "browser-1", backend: "codex-browser", browserSessionId: "iab:tab-1", agentSessionId: "runtime:codex:thread-1", title: "Example", url: "https://example.com", viewport: { width: 1280, height: 720 }, availability });
}

describe("LiveViewRegistry", () => {
  it("announces sessions to connected same-user clients before they select one", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const viewer = peer("viewer");
    const otherUser = { ...peer("other"), userId: "other-user" };
    registry.connect(producer);
    registry.connect(viewer);
    registry.connect(otherUser);

    publish(registry, producer);

    expect(viewer.messages).toContainEqual(expect.objectContaining({
      type: "browser:session",
      session: expect.objectContaining({ id: "browser-1" }),
    }));
    expect(otherUser.messages).toEqual([]);

    registry.close(producer, "browser-1");
    expect(viewer.messages).toContainEqual(expect.objectContaining({
      type: "browser:closed",
      session: expect.objectContaining({ id: "browser-1" }),
    }));
    expect(otherUser.messages).toEqual([]);
  });

  it("fans frames out only to viewers of the published session", () => {
    const registry = new LiveViewRegistry(() => 100);
    const producer = peer("producer");
    const viewer = peer("viewer");
    const bystander = peer("bystander");
    publish(registry, producer);
    registry.watch(viewer, "browser-1");
    registry.updateFrame(producer, { sessionId: "browser-1", sequence: 3, data: new Uint8Array(32).fill(7) });
    expect(viewer.messages.at(-1)).toMatchObject({ type: "browser:frame", sessionId: "browser-1", sequence: 3 });
    expect(bystander.messages).toEqual([]);
  });

  it("allows one controller and rejects a competing takeover", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const controller = peer("controller");
    const observer = peer("observer");
    publish(registry, producer);
    expect(registry.takeOver(controller, "browser-1").state).toBe("handoff-requested");
    expect(() => registry.takeOver(observer, "browser-1")).toThrow("another viewer");
    registry.producerState(producer, "browser-1", "user-controlled");
    registry.input(controller, "browser-1", { kind: "pointer", action: "down", x: 0.25, y: 0.75 });
    expect(producer.messages.at(-1)).toMatchObject({ type: "browser:input" });
    expect(() => registry.input(observer, "browser-1", { kind: "pointer", action: "down", x: 0.2, y: 0.2 })).toThrow("read-only");
  });

  it("waits for producer resynchronization before releasing control", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const controller = peer("controller");
    publish(registry, producer);
    registry.takeOver(controller, "browser-1");
    registry.producerState(producer, "browser-1", "user-controlled");
    expect(registry.returnControl(controller, "browser-1").state).toBe("return-requested");
    registry.producerState(producer, "browser-1", "resyncing");
    expect(registry.list(controller)[0]).toMatchObject({ isController: true, state: "resyncing" });
    registry.producerState(producer, "browser-1", "agent-controlled");
    expect(registry.list(controller)[0]).toMatchObject({ isController: false, state: "agent-controlled" });
  });

  it("requests return when the controller disconnects", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const controller = peer("controller");
    publish(registry, producer);
    registry.takeOver(controller, "browser-1");
    registry.producerState(producer, "browser-1", "user-controlled");
    registry.disconnect(controller);
    expect(producer.messages.at(-1)).toMatchObject({ type: "browser:return-requested", reason: "controller-disconnected" });
  });

  it("does not hand control to a viewer until the producer has delivered a frame", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const viewer = peer("viewer");
    publish(registry, producer, "starting");
    expect(() => registry.takeOver(viewer, "browser-1")).toThrow("not ready");
    registry.updateFrame(producer, { sessionId: "browser-1", sequence: 1, data: new Uint8Array(32).fill(7) });
    expect(registry.takeOver(viewer, "browser-1").state).toBe("handoff-requested");
  });

  it("surfaces producer capability failures and keeps the session read-only", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const viewer = peer("viewer");
    registry.publish(producer, {
      sessionId: "browser-1",
      backend: "ego-browser",
      availability: "unavailable",
      capabilityError: "ego-browser did not expose screencast frames",
      capabilityErrorCode: "BROWSER_LIVE_STREAM_UNAVAILABLE",
    });
    expect(registry.list(viewer)[0]).toMatchObject({
      availability: "unavailable",
      capabilityErrorCode: "BROWSER_LIVE_STREAM_UNAVAILABLE",
    });
    expect(() => registry.takeOver(viewer, "browser-1")).toThrow("did not expose");
  });

  it("deduplicates repeated takeover and return commands", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const controller = peer("controller");
    publish(registry, producer);
    registry.takeOver(controller, "browser-1");
    registry.takeOver(controller, "browser-1");
    expect(producer.messages.filter((message) => message.type === "browser:takeover-requested")).toHaveLength(1);
    registry.producerState(producer, "browser-1", "user-controlled");
    registry.returnControl(controller, "browser-1");
    registry.returnControl(controller, "browser-1");
    expect(producer.messages.filter((message) => message.type === "browser:return-requested")).toHaveLength(1);
  });

  it("accepts a desktop source and defaults its title", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const viewer = peer("viewer");
    registry.connect(producer);
    registry.connect(viewer);
    registry.publish(producer, { sessionId: "desktop:primary", backend: "desktop" });
    expect(registry.list(viewer)[0]).toMatchObject({ backend: "desktop", title: "桌面屏幕" });
  });

  it("rejects unknown sources", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    registry.connect(producer);
    expect(() => registry.publish(producer, { sessionId: "x", backend: "tv" })).toThrow(/unsupported/);
  });
});
