import { describe, expect, it, vi } from "vitest";
import { captureDesktopFrame, DesktopScreenScreencast, type DesktopCapturedSource } from "./desktop-screen-screencast";

interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

function fakeClock(): FakeClock {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
  };
}

function makeThumbnail(bytes: number, width: number, height: number): NonNullable<DesktopCapturedSource["thumbnail"]> {
  return {
    toJPEG: () => Buffer.alloc(bytes, 0x7f),
    getSize: () => ({ width, height }),
  };
}

describe("DesktopScreenScreencast", () => {
  it("captures one reusable bounded frame with pixel and logical geometry", async () => {
    const frame = await captureDesktopFrame({
      display: { originX: -1440, originY: 120, width: 1440, height: 900, scaleFactor: 2, id: "screen:2" },
      captureSources: async () => [{ id: "screen:2", thumbnail: makeThumbnail(64, 2880, 1800) }],
    });
    expect(frame).toMatchObject({
      width: 2880,
      height: 1800,
      logicalWidth: 1440,
      logicalHeight: 900,
      originX: -1440,
      originY: 120,
      displayId: "screen:2",
    });
    expect(frame?.data.byteLength).toBe(64);
  });

  it("captures Retina pixels while keeping logical screen coordinates", async () => {
    const clock = fakeClock();
    const captureSources = vi.fn().mockResolvedValue([
      { id: "screen:1", thumbnail: makeThumbnail(64, 2880, 1800) },
      { id: "screen:2", thumbnail: makeThumbnail(64, 100, 100) },
    ]);
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async () => undefined },
      displayInfo: () => ({ originX: 0, originY: 0, width: 1440, height: 900, scaleFactor: 2, id: "screen:0" }),
      captureSources,
      primaryDisplayId: () => "screen:1",
      now: clock.now,
      sleep: async (ms) => { clock.advance(ms); },
    });
    const viewports: unknown[] = [];
    const running = screencast.start(async (frame) => {
      viewports.push(frame.viewport);
      await screencast.stop();
    });
    await running;
    // Native Retina pixels are preserved for full-clarity fallback frames.
    expect(captureSources).toHaveBeenCalledWith({ width: 2880, height: 1800 });
    expect(viewports).toEqual([{ width: 1440, height: 900, deviceScaleFactor: 2 }]);
  });

  it("falls back to the first source when the primary id is unknown", async () => {
    const clock = fakeClock();
    const captureSources = vi.fn().mockResolvedValue([
      { id: "screen:0", thumbnail: makeThumbnail(64, 1440, 900) },
    ]);
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async () => undefined },
      displayInfo: () => ({ originX: 0, originY: 0, width: 1440, height: 900, scaleFactor: 1, id: "screen:0" }),
      captureSources,
      now: clock.now,
      sleep: async (ms) => { clock.advance(ms); },
    });
    const running = screencast.start(async () => {
      await screencast.stop();
    });
    await running;
    expect(captureSources).toHaveBeenCalled();
  });

  it("reduces the target fps when the downstream rejects frames", async () => {
    const clock = fakeClock();
    let counter = 0;
    const captureSources = vi.fn().mockImplementation(async () => {
      counter += 1;
      return [{ id: "screen:0", thumbnail: makeThumbnail(16 + counter, 1440, 900) }];
    });
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async () => undefined },
      displayInfo: () => ({ originX: 0, originY: 0, width: 1440, height: 900, scaleFactor: 1, id: "screen:0" }),
      captureSources,
      fps: 4,
      now: clock.now,
      sleep: async (ms) => { clock.advance(ms); },
    });
    let frames = 0;
    const running = screencast.start(async () => {
      frames += 1;
      clock.advance(600); // slow downstream send
      if (frames >= 3) await screencast.stop();
      return { accepted: false };
    });
    await running;
    expect(frames).toBe(3);
    expect(screencast["targetFps"]).toBeLessThan(4);
  });

  it("throws the capability error when no source appears before the deadline", async () => {
    const clock = fakeClock();
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async () => undefined },
      displayInfo: () => ({ originX: 0, originY: 0, width: 1440, height: 900, scaleFactor: 1, id: "screen:0" }),
      captureSources: async () => [],
      firstFrameTimeoutMs: 4_000,
      now: clock.now,
      sleep: async (ms) => { clock.advance(ms); },
    });
    await expect(screencast.start(async () => undefined)).rejects.toMatchObject({
      code: "BROWSER_LIVE_STREAM_UNAVAILABLE",
    });
  });

  it("maps normalized input to absolute desktop commands with drag tracking", async () => {
    const dispatched: unknown[] = [];
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async (command: unknown) => { dispatched.push(command); } },
      displayInfo: () => ({ originX: 0, originY: 0, width: 1440, height: 900, scaleFactor: 2, id: "screen:0" }),
      captureSources: async () => [{ id: "screen:0", thumbnail: makeThumbnail(32, 1440, 900) }],
      now: () => 1,
      sleep: async () => undefined,
    });
    // Electron may downsample the returned image. Input must still use the
    // real 1440×900 desktop after capture, not 1440/2 × 900/2.
    await screencast.start(async () => { await screencast.stop(); });
    await screencast.dispatchInput({ kind: "pointer", action: "move", x: 0.5, y: 0.25, button: "left", deltaX: 0, deltaY: 0 });
    await screencast.dispatchInput({ kind: "pointer", action: "down", x: 0.5, y: 0.25, button: "left", deltaX: 0, deltaY: 0 });
    await screencast.dispatchInput({ kind: "pointer", action: "move", x: 0.6, y: 0.3, button: "left", deltaX: 0, deltaY: 0 });
    await screencast.dispatchInput({ kind: "pointer", action: "up", x: 0.6, y: 0.3, button: "left", deltaX: 0, deltaY: 0 });
    await screencast.dispatchInput({ kind: "pointer", action: "wheel", x: 0.6, y: 0.3, button: "left", deltaX: 0, deltaY: 120 });
    await screencast.dispatchInput({ kind: "key", action: "down", key: "a", code: "KeyA", text: "", modifiers: ["Shift"] });
    await screencast.dispatchInput({ kind: "key", action: "down", key: "", code: "", text: "你好", modifiers: [] });

    expect(dispatched).toEqual([
      { op: "move", x: 720, y: 225 },
      { op: "down", x: 720, y: 225, button: "left", click: 1 },
      { op: "drag", x: 864, y: 270 },
      { op: "up", x: 864, y: 270, button: "left", click: 1 },
      // Wheel first parks the cursor at the pointer position so the scroll
      // lands on the window the viewer is actually looking at.
      { op: "move", x: 864, y: 270 },
      { op: "wheel", deltaX: 0, deltaY: 120 },
      { op: "key", action: "down", code: "KeyA", modifiers: ["Shift"] },
      { op: "text", text: "你好" },
    ]);
  });

  it("offsets injected coordinates by the streamed display's global origin", async () => {
    const dispatched: unknown[] = [];
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async (command: unknown) => { dispatched.push(command); } },
      // A second display sitting right of the primary one.
      displayInfo: () => ({ originX: 2560, originY: 495, width: 1352, height: 878, scaleFactor: 2, id: "screen:1" }),
      captureSources: async () => [{ id: "screen:1", thumbnail: makeThumbnail(32, 1352, 878) }],
      now: () => 1,
      sleep: async () => undefined,
    });
    await screencast.start(async () => { await screencast.stop(); });
    await screencast.dispatchInput({ kind: "pointer", action: "down", x: 0.25, y: 0.5, button: "left", deltaX: 0, deltaY: 0 });
    await screencast.dispatchInput({ kind: "pointer", action: "wheel", x: 0.25, y: 0.5, button: "left", deltaX: 0, deltaY: 60 });
    expect(dispatched).toEqual([
      // Screen-global coordinates: display origin + normalized position.
      { op: "down", x: 2560 + 338, y: 495 + 439, button: "left", click: 1 },
      { op: "move", x: 2560 + 338, y: 495 + 439 },
      { op: "wheel", deltaX: 0, deltaY: 60 },
    ]);
  });

  it("picks the capture source matching the streamed display id", async () => {
    const captureSources = vi.fn(async () => [
      { id: "screen:0", thumbnail: makeThumbnail(32, 100, 100) },
      { id: "screen:1", thumbnail: makeThumbnail(64, 1352, 878) },
    ]);
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async () => undefined },
      displayInfo: () => ({ originX: 2560, originY: 495, width: 1352, height: 878, scaleFactor: 2, id: "screen:1" }),
      captureSources,
      primaryDisplayId: () => "screen:1",
      now: () => 1,
      sleep: async () => undefined,
    });
    let jpegBytes = 0;
    await screencast.start(async (frame) => {
      jpegBytes = (frame.data as Uint8Array).byteLength;
      await screencast.stop();
    });
    expect(jpegBytes).toBe(64);
  });

  it("returns the helper hit-test reply for pointer releases only", async () => {
    const hitTest = { ok: true, editable: true, bounds: { x: 100, y: 200, w: 300, h: 40 } };
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async (command: unknown) => ((command as { op: string }).op === "up" ? hitTest : { ok: true }) },
      displayInfo: () => ({ originX: 0, originY: 0, width: 1440, height: 900, scaleFactor: 1, id: "screen:0" }),
      captureSources: async () => [{ id: "screen:0", thumbnail: makeThumbnail(32, 1440, 900) }],
      now: () => 1,
      sleep: async () => undefined,
    });
    await screencast.start(async () => { await screencast.stop(); });
    await expect(screencast.dispatchInput({ kind: "pointer", action: "up", x: 0.5, y: 0.5, button: "left", deltaX: 0, deltaY: 0 }))
      .resolves.toEqual(hitTest);
    await expect(screencast.dispatchInput({ kind: "pointer", action: "down", x: 0.5, y: 0.5, button: "left", deltaX: 0, deltaY: 0 }))
      .resolves.toBeNull();
  });
});

describe("webrtc standby capture", () => {
  it("stands down to a 1 FPS half-scale watchdog while WebRTC carries the video", async () => {
    const clock = fakeClock();
    let captures = 0;
    const sizes: Array<{ width: number; height: number }> = [];
    const captureSources = vi.fn(async (size: { width: number; height: number }) => {
      captures += 1;
      sizes.push(size);
      return [{ id: "screen:0", thumbnail: makeThumbnail(32, 1440, 900) }];
    });
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async () => undefined },
      displayInfo: () => ({ originX: 0, originY: 0, width: 1440, height: 900, scaleFactor: 2, id: "screen:0" }),
      captureSources,
      now: clock.now,
      sleep: async (ms) => { clock.advance(ms); },
    });
    const running = screencast.start(async () => {
      if (captures === 2) screencast.setStandby(true);
      if (captures >= 4) await screencast.stop();
    });
    await running;
    // Native Retina budget while active…
    expect(sizes[0]).toEqual({ width: 2880, height: 1800 });
    // …and a half-scale watchdog once WebRTC takes over the real stream.
    expect(sizes[2]).toEqual({ width: 1440, height: 900 });
    expect(clock.now() - 1_000_000).toBeGreaterThanOrEqual(2_000); // 1s standby gaps
  });
});


describe("desktop capture quality budget", () => {
  it("keeps native resolution and reduces encoding quality to fit the frame cap", async () => {
    const toJPEG = vi.fn((quality: number) => Buffer.alloc(quality > 70 ? 700 * 1024 : 600 * 1024));
    const captureSources = vi.fn(async () => [{ id: "screen:0", thumbnail: { toJPEG, getSize: () => ({ width: 3840, height: 2160 }) } }]);
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async () => undefined },
      displayInfo: () => ({ originX: 0, originY: 0, width: 2560, height: 1440, scaleFactor: 2, id: "screen:0" }),
      captureSources,
    });
    await screencast.start(async (frame) => {
      expect(frame.data).toBeInstanceOf(Uint8Array);
      expect((frame.data as Uint8Array).byteLength).toBeLessThanOrEqual(640 * 1024);
      expect(frame.viewport).toEqual({ width: 2560, height: 1440, deviceScaleFactor: 2 });
      await screencast.stop();
    });
    expect(captureSources).toHaveBeenCalledWith({ width: 3840, height: 2160 });
    expect(toJPEG.mock.calls.map(([quality]) => quality)).toEqual([90, 80, 70]);
  });
});

describe("input driven screen refresh", () => {
  it("wakes the sleeping capture loop as soon as input finishes", async () => {
    let sleeping!: () => void;
    const enteredSleep = new Promise<void>((resolve) => { sleeping = resolve; });
    let count = 0;
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async () => undefined },
      displayInfo: () => ({ originX: 0, originY: 0, width: 1440, height: 900, scaleFactor: 1, id: "screen:0" }),
      captureSources: async () => [{ id: "screen:0", thumbnail: makeThumbnail(32, 1440, 900) }],
      sleep: () => { sleeping(); return new Promise(() => {}); },
    });
    const running = screencast.start(async () => {
      count++;
      if (count === 2) await screencast.stop();
    });
    await enteredSleep;
    await screencast.dispatchInput({ kind: "pointer", action: "up", x: .5, y: .5, button: "left", deltaX: 0, deltaY: 0 });
    await running;
    expect(count).toBe(2);
  });

  it("reuses the JPEG quality that fit instead of retrying oversized encodings", async () => {
    const toJPEG = vi.fn((quality: number) => Buffer.alloc(quality > 70 ? 700 * 1024 : 32));
    let frames = 0;
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async () => undefined },
      displayInfo: () => ({ originX: 0, originY: 0, width: 1440, height: 900, scaleFactor: 2, id: "screen:0" }),
      captureSources: async () => [{ id: "screen:0", thumbnail: { toJPEG, getSize: () => ({ width: 2880, height: 1800 }) } }],
      now: () => 100,
      sleep: async () => undefined,
    });
    await screencast.start(async () => { if (++frames === 3) await screencast.stop(); });
    expect(toJPEG.mock.calls.map(([quality]) => quality)).toEqual([90, 80, 70, 70, 70]);
  });
});
