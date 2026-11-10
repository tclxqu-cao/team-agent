import { describe, expect, it, vi } from "vitest";
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
  it('shares ordered native receipts between reliable input and RPC, including renegotiation', async () => {
    const registry = new LiveViewRegistry(), producer = peer('producer'), controller = peer('controller');
    publish(registry, producer); registry.takeOver(controller, 'browser-1'); registry.producerState(producer, 'browser-1', 'user-controlled');
    const context = { controllerId: controller.id, epoch: 1, stream: 'input-stream-1234567890', version: 2 };
    registry.enableDirectInput(producer, 'browser-1', context);
    const input = { kind: 'key', action: 'down', text: '中文输入', key: '', code: '' };
    const second = registry.input(controller, 'browser-1', { kind: 'pointer', action: 'up', x: .2, y: .4,
      direct: { stream: context.stream, index: 2, sequence: 4 } });
    const first = registry.directReliableInput(producer, 'browser-1', context, { stream: context.stream, index: 1, sequence: 2, input });
    const duplicate = registry.input(controller, 'browser-1', { ...input, direct: { stream: context.stream, index: 1, sequence: 2 } });
    expect(first).toBe(duplicate);
    const sent = producer.messages.filter(message => message.type === 'browser:input'); expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ reliableContext: context, input: { text: '中文输入' } });
    registry.inputResult(producer, 'browser-1', sent[0].token, { inserted: true });
    expect(await first).toEqual({ inserted: true }); await Promise.resolve();
    const next = producer.messages.filter(message => message.type === 'browser:input'); expect(next).toHaveLength(2);
    registry.inputResult(producer, 'browser-1', next[1].token, { editable: true }); expect(await second).toEqual({ editable: true });
    registry.enableDirectInput(producer, 'browser-1', { ...context, stream: 'input-stream-2222222222' });
    expect(await registry.input(controller, 'browser-1', { ...input, direct: { stream: context.stream, index: 1, sequence: 2 } })).toEqual({ inserted: true });
    await expect(registry.input(controller, 'browser-1', { ...input, direct: { stream: context.stream, index: 3, sequence: 6 } })).rejects.toMatchObject({ code: 'ESTALE' });
  });

  it('cancels gapped reliable work when capture becomes unavailable and does not revive its old lease', async () => {
    const registry = new LiveViewRegistry(), producer = peer('producer'), controller = peer('controller');
    publish(registry, producer); registry.takeOver(controller, 'browser-1'); registry.producerState(producer, 'browser-1', 'user-controlled');
    const context = { controllerId: controller.id, epoch: 1, stream: 'input-stream-1234567890', version: 2 };
    registry.enableDirectInput(producer, 'browser-1', context);
    const input = { kind: 'key', text: 'queued', direct: { stream: context.stream, index: 2, sequence: 2 } };
    const waiting = expect(registry.input(controller, 'browser-1', input)).rejects.toMatchObject({ code: 'ESTALE' });
    registry.updateAvailability(producer, 'browser-1', { availability: 'unavailable' }); await waiting;
    registry.updateAvailability(producer, 'browser-1', { availability: 'ready' });
    expect(registry.isDirectInputActive(producer, 'browser-1', context)).toBe(false);
    expect(producer.messages.filter(event => event.type === 'browser:input')).toHaveLength(0);
  });

  it('binds direct hover to a trusted controller epoch and reliable input fence', async () => {
    const registry = new LiveViewRegistry(), producer = peer('producer'), controller = peer('controller');
    publish(registry, producer); registry.takeOver(controller, 'browser-1');
    registry.producerState(producer, 'browser-1', 'user-controlled');
    registry.webrtcFromViewer(controller, 'browser-1', { kind: 'start', inputVersion: 1, controllerId: 'forged', controlEpoch: 99 });
    const signal = producer.messages.at(-1)!;
    expect(signal).toMatchObject({ controllerId: 'controller', controlEpoch: 1 });
    const context = { controllerId: signal.controllerId as string, epoch: signal.controlEpoch as number, stream: 'input-stream-1234567890' };
    expect(registry.enableDirectInput(producer, 'browser-1', context)).toBe(true);
    const move = { stream: context.stream, sequence: 1, barrier: 0, x: .25, y: .75 };
    expect(registry.directPointerInput(producer, 'browser-1', context, move)).toBe(true);
    expect(producer.messages.at(-1)).toMatchObject({ type: 'browser:input', directMove: true, input: { action: 'move', x: .25 } });
    await registry.input(controller, 'browser-1', { kind: 'key', key: 'a', direct: { stream: context.stream, sequence: 2 } });
    expect(registry.directPointerInput(producer, 'browser-1', context, { ...move, sequence: 3 })).toBe(false);
    expect(registry.directPointerInput(producer, 'browser-1', context, { ...move, sequence: 3, barrier: 2 })).toBe(true);
    registry.returnControl(controller, 'browser-1');
    // Revocation is immediate, even before the producer confirms agent-controlled state.
    expect(registry.isDirectInputActive(producer, 'browser-1', context)).toBe(false);
    expect(registry.directPointerInput(producer, 'browser-1', context, { ...move, sequence: 4, barrier: 2 })).toBe(false);
  });

  it('retires old streams on renegotiation and refuses non-producer, stale and disconnected authorization', () => {
    const registry = new LiveViewRegistry(), producer = peer('producer'), controller = peer('controller');
    publish(registry, producer); registry.takeOver(controller, 'browser-1');
    registry.producerState(producer, 'browser-1', 'user-controlled');
    const context = { controllerId: controller.id, epoch: 1, stream: 'input-stream-1234567890' };
    expect(registry.enableDirectInput(producer, 'browser-1', { ...context, epoch: 0 })).toBe(false);
    expect(() => registry.enableDirectInput(controller, 'browser-1', context)).toThrow('producer mismatch');
    expect(registry.enableDirectInput(producer, 'browser-1', context)).toBe(true);
    expect(registry.enableDirectInput(producer, 'browser-1', { ...context, stream: 'input-stream-2222222222' })).toBe(true);
    expect(registry.isDirectInputActive(producer, 'browser-1', context)).toBe(false);
    const next = { ...context, stream: 'input-stream-2222222222' };
    expect(registry.isDirectInputActive(producer, 'browser-1', next)).toBe(true);
    registry.unwatch(controller);
    expect(registry.isDirectInputActive(producer, 'browser-1', next)).toBe(false);
  });

  it('keeps legacy reliable input functional while invalidating its unfenced hover stream', async () => {
    const registry = new LiveViewRegistry(), producer = peer('producer'), controller = peer('controller');
    publish(registry, producer); registry.takeOver(controller, 'browser-1');
    registry.producerState(producer, 'browser-1', 'user-controlled');
    const context = { controllerId: controller.id, epoch: 1, stream: 'input-stream-1234567890' };
    registry.enableDirectInput(producer, 'browser-1', context);
    await registry.input(controller, 'browser-1', { kind: 'pointer', action: 'down', x: .1, y: .1 });
    expect(producer.messages.at(-1)).toMatchObject({ type: 'browser:input', input: { action: 'down' } });
    expect(registry.isDirectInputActive(producer, 'browser-1', context)).toBe(false);
  });
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

  it("clears a dormant producer frame without dropping its watchers", () => {
    const registry = new LiveViewRegistry(() => 100);
    const producer = peer("producer");
    const viewer = peer("viewer");
    publish(registry, producer, "starting");
    registry.watch(viewer, "browser-1");
    registry.updateFrame(producer, { sessionId: "browser-1", sequence: 1, data: new Uint8Array(32).fill(7) });

    expect(registry.updateAvailability(producer, "browser-1", {
      availability: "starting",
      clearFrame: true,
    })).toMatchObject({ availability: "starting", viewerCount: 1 });

    const framesBeforeRewatch = viewer.messages.filter((message) => message.type === "browser:frame").length;
    registry.watch(viewer, "browser-1");
    expect(viewer.messages.filter((message) => message.type === "browser:frame")).toHaveLength(framesBeforeRewatch);
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

  it("resolves input with the producer dispatch result under a token", async () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const controller = peer("controller");
    publish(registry, producer);
    registry.takeOver(controller, "browser-1");
    registry.producerState(producer, "browser-1", "user-controlled");

    const reply = registry.input(controller, "browser-1", { kind: "pointer", action: "up", x: 0.5, y: 0.5 });
    const forwarded = producer.messages.at(-1) as { token?: number };
    expect(typeof forwarded.token).toBe("number");
    expect(registry.inputResult(producer, "browser-1", forwarded.token, { editable: true, bounds: { x: 10, y: 20, w: 30, h: 40 } }))
      .toEqual({ delivered: true });
    await expect(reply).resolves.toEqual({ editable: true, bounds: { x: 10, y: 20, w: 30, h: 40 } });
  });

  it("round trips read-only pointer probes without converting them into clicks", async () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const controller = peer("controller");
    publish(registry, producer);
    registry.takeOver(controller, "browser-1");
    registry.producerState(producer, "browser-1", "user-controlled");

    const reply = registry.input(controller, "browser-1", { kind: "pointer", action: "move", probe: true, x: 0.5, y: 0.5 });
    const forwarded = producer.messages.at(-1) as { token?: number };
    expect(producer.messages.at(-1)).toMatchObject({ input: { action: "move", probe: true } });
    expect(typeof forwarded.token).toBe("number");
    expect(registry.inputResult(producer, "browser-1", forwarded.token, { editable: true, bounds: { x: 10, y: 20, w: 30, h: 40 } }))
      .toEqual({ delivered: true });
    await expect(reply).resolves.toEqual({ editable: true, bounds: { x: 10, y: 20, w: 30, h: 40 } });
  });

  it("preserves pasted URLs, whitespace and Unicode until the producer confirms input", async () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const controller = peer("controller");
    publish(registry, producer);
    registry.takeOver(controller, "browser-1");
    registry.producerState(producer, "browser-1", "user-controlled");
    const text = "  http://localhost:3001/中文?q=a%20b\n";
    const reply = registry.input(controller, "browser-1", { kind: "key", action: "down", text });
    const event = producer.messages.at(-1)!;
    expect(event).toMatchObject({ type: "browser:input", input: { text } });
    expect(event.token).toEqual(expect.any(Number));
    registry.inputResult(producer, "browser-1", event.token, { accepted: true });
    await expect(reply).resolves.toEqual({ accepted: true });
  });

  it("returns native paste failures and rejects oversized text before dispatch", async () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const controller = peer("controller");
    publish(registry, producer);
    registry.takeOver(controller, "browser-1");
    registry.producerState(producer, "browser-1", "user-controlled");
    const reply = registry.input(controller, "browser-1", { kind: "key", text: "http://localhost:3001" });
    registry.inputResult(producer, "browser-1", producer.messages.at(-1)!.token, { error: "辅助功能未授权" });
    await expect(reply).resolves.toEqual({ error: "辅助功能未授权" });
    const count = producer.messages.length;
    expect(() => registry.input(controller, "browser-1", { kind: "key", text: "x".repeat(2001) })).toThrow("too long");
    expect(producer.messages).toHaveLength(count);
  });

  it("reports missing text confirmation instead of accepting a timed out paste", async () => {
    vi.useFakeTimers();
    try {
      const registry = new LiveViewRegistry();
      const producer = peer("producer");
      const controller = peer("controller");
      publish(registry, producer);
      registry.takeOver(controller, "browser-1");
      registry.producerState(producer, "browser-1", "user-controlled");
      const reply = registry.input(controller, "browser-1", { kind: "key", text: "http://localhost:3001" });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(reply).resolves.toMatchObject({ error: expect.stringContaining("未确认") });
    } finally { vi.useRealTimers(); }
  });

  it("resolves input with null when the producer never replies", async () => {
    const registry = new LiveViewRegistry(() => 100, 5);
    const producer = peer("producer");
    const controller = peer("controller");
    publish(registry, producer);
    registry.takeOver(controller, "browser-1");
    registry.producerState(producer, "browser-1", "user-controlled");

    const reply = registry.input(controller, "browser-1", { kind: "pointer", action: "up", x: 0.5, y: 0.5 });
    await expect(reply).resolves.toBeNull();
  });

  it("publishes display options only when there is a choice and forwards switches from the controller", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const controller = peer("controller");
    const observer = peer("observer");
    // Single-display metadata is not exposed to viewers.
    registry.publish(producer, { sessionId: "browser-1", backend: "desktop", displays: [{ id: "1", label: "主屏", primary: true, selected: true }] });
    expect(publish(registry, producer).displays ?? null).toBeNull();
    // Multi-display metadata flows through and the controller can switch.
    const view = registry.publish(producer, {
      sessionId: "browser-1", backend: "desktop",
      displays: [
        { id: "3", label: "主屏", primary: true, selected: true },
        { id: "1", label: "屏幕 2", primary: false, selected: false },
      ],
    });
    expect(view.displays).toHaveLength(2);
    registry.takeOver(controller, "browser-1");
    registry.producerState(producer, "browser-1", "user-controlled");
    expect(registry.setDisplay(controller, "browser-1", "1").displays).toHaveLength(2);
    expect(producer.messages.at(-1)).toMatchObject({ type: "browser:set-display", sessionId: "browser-1", displayId: "1" });
    expect(() => registry.setDisplay(observer, "browser-1", "1")).toThrow("read-only");
    expect(() => registry.setDisplay(controller, "browser-1", "999")).toThrow("unknown display");
  });

  it("routes webrtc signaling between the controller and the producer only", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const controller = peer("controller");
    const observer = peer("observer");
    publish(registry, producer);
    registry.takeOver(controller, "browser-1");
    registry.producerState(producer, "browser-1", "user-controlled");

    const offer = { kind: "offer", sdp: { type: "offer", sdp: "v=0" } };
    expect(registry.webrtcFromViewer(controller, "browser-1", offer)).toEqual({ accepted: true });
    expect(producer.messages.at(-1)).toMatchObject({ type: "browser:webrtc", sessionId: "browser-1", data: offer });
    expect(() => registry.webrtcFromViewer(observer, "browser-1", offer)).toThrow("read-only");

    const ice = { kind: "ice", candidate: { candidate: "candidate:1" } };
    expect(registry.webrtcFromProducer(producer, "browser-1", ice)).toEqual({ delivered: true });
    expect(controller.messages.at(-1)).toMatchObject({ type: "browser:webrtc", sessionId: "browser-1", data: ice });
    for (const quality of ["smooth", "hd", "original"]) {
      expect(registry.webrtcFromViewer(controller, "browser-1", {kind:"quality",quality})).toEqual({accepted:true});
      expect(() => registry.webrtcFromViewer(observer, "browser-1", {kind:"quality",quality})).toThrow("read-only");
      expect(registry.webrtcFromProducer(producer, "browser-1", {kind:"quality-state",quality})).toEqual({delivered:true});
    }
    expect(observer.messages).toEqual([]);
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
    registry.publish(producer, { sessionId: "desktop:primary", backend: "desktop", platform: "win32" });
    expect(registry.list(viewer)[0]).toMatchObject({ backend: "desktop", title: "桌面屏幕", platform: "win32" });
  });

  it("validates audio capabilities and keeps audio signaling controller-only", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    const controller = peer("controller");
    const observer = peer("observer");
    const audioCapabilities = { fullDuplex: true, systemAudio: true, microphonePlayback: true, selfPlaybackExclusion: true };
    registry.publish(producer, { sessionId: "desktop", backend: "desktop", availability: "ready", audioCapabilities });
    expect(registry.list(observer)[0].audioCapabilities).toEqual(audioCapabilities);
    registry.takeOver(controller, "desktop");
    registry.producerState(producer, "desktop", "user-controlled");
    expect(registry.webrtcFromViewer(controller, "desktop", { kind: "audio-start" })).toEqual({ accepted: true });
    expect(() => registry.webrtcFromViewer(observer, "desktop", { kind: "audio-start" })).toThrow("read-only");
    expect(registry.webrtcFromProducer(producer, "desktop", { kind: "audio-state", state: "live" })).toEqual({ delivered: true });
    expect(controller.messages.at(-1)).toMatchObject({ data: { kind: "audio-state", state: "live" } });
  });

  it("omits malformed audio capabilities for backward compatibility", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    registry.publish(producer, { sessionId: "desktop", backend: "desktop", audioCapabilities: { fullDuplex: true } });
    expect(registry.list(peer("viewer"))[0].audioCapabilities).toBeUndefined();
  });

  it("rejects unknown sources", () => {
    const registry = new LiveViewRegistry();
    const producer = peer("producer");
    registry.connect(producer);
    expect(() => registry.publish(producer, { sessionId: "x", backend: "tv" })).toThrow(/unsupported/);
  });
});

it('lets a watching device change capture settings without taking input control, but respects another controller',()=>{
 const registry=new LiveViewRegistry();const producer=peer('producer'),viewer=peer('viewer'),other=peer('other');
 for(const p of [producer,viewer,other])registry.connect(p);
 registry.publish(producer,{sessionId:'desktop',backend:'desktop',availability:'ready',displays:[{id:'1',label:'one',primary:true,selected:true},{id:'2',label:'two',primary:false,selected:false}]});
 expect(()=>registry.setDisplay(viewer,'desktop','2')).toThrow('read-only');
 registry.watch(viewer,'desktop');
 expect(registry.setDisplay(viewer,'desktop','2').isController).toBe(false);
 expect(registry.webrtcFromViewer(viewer,'desktop',{kind:'quality',quality:'original'})).toEqual({accepted:true});
 expect(()=>registry.webrtcFromViewer(viewer,'desktop',{kind:'start'})).toThrow('read-only');
 expect(()=>registry.input(viewer,'desktop',{kind:'pointer',action:'move',x:0,y:0})).toThrow('read-only');
 registry.webrtcFromProducer(producer,'desktop',{kind:'quality-state',quality:'original'});
 expect(viewer.messages.at(-1)).toMatchObject({data:{quality:'original'}});
 registry.watch(other,'desktop');expect(other.messages.at(-1)).toMatchObject({data:{quality:'original'}});
 registry.takeOver(other,'desktop');
 expect(()=>registry.setDisplay(viewer,'desktop','1')).toThrow('read-only');
 expect(()=>registry.webrtcFromViewer(viewer,'desktop',{kind:'quality',quality:'hd'})).toThrow('read-only');
});
