import { describe, expect, it, vi } from "vitest";
import { DesktopScreenScreencast, type DesktopCapturedSource } from "./desktop-screen-screencast";

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
  it("captures the primary display and derives viewport from thumbnail pixels", async () => {
    const clock = fakeClock();
    const captureSources = vi.fn().mockResolvedValue([
      { id: "screen:1", thumbnail: makeThumbnail(64, 2880, 1800) },
      { id: "screen:2", thumbnail: makeThumbnail(64, 100, 100) },
    ]);
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async () => undefined },
      displayInfo: () => ({ width: 1440, height: 900, scaleFactor: 2 }),
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
    expect(captureSources).toHaveBeenCalledWith({ width: 1440, height: 900 });
    expect(viewports).toEqual([{ width: 1440, height: 900, deviceScaleFactor: 2 }]);
  });

  it("falls back to the first source when the primary id is unknown", async () => {
    const clock = fakeClock();
    const captureSources = vi.fn().mockResolvedValue([
      { id: "screen:0", thumbnail: makeThumbnail(64, 1440, 900) },
    ]);
    const screencast = new DesktopScreenScreencast({
      input: { dispatch: async () => undefined },
      displayInfo: () => ({ width: 1440, height: 900, scaleFactor: 1 }),
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
      displayInfo: () => ({ width: 1440, height: 900, scaleFactor: 1 }),
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
      displayInfo: () => ({ width: 1440, height: 900, scaleFactor: 1 }),
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
      displayInfo: () => ({ width: 1440, height: 900, scaleFactor: 2 }),
      captureSources: async () => [{ id: "screen:0", thumbnail: makeThumbnail(32, 1440, 900) }],
      now: () => 1,
      sleep: async () => undefined,
    });
    await screencast.dispatchInput({ kind: "pointer", action: "move", x: 0.5, y: 0.25, button: "left", deltaX: 0, deltaY: 0 });
    await screencast.dispatchInput({ kind: "pointer", action: "down", x: 0.5, y: 0.25, button: "left", deltaX: 0, deltaY: 0 });
    await screencast.dispatchInput({ kind: "pointer", action: "move", x: 0.6, y: 0.3, button: "left", deltaX: 0, deltaY: 0 });
    await screencast.dispatchInput({ kind: "pointer", action: "up", x: 0.6, y: 0.3, button: "left", deltaX: 0, deltaY: 0 });
    await screencast.dispatchInput({ kind: "pointer", action: "wheel", x: 0.6, y: 0.3, button: "left", deltaX: 0, deltaY: 120 });
    await screencast.dispatchInput({ kind: "key", action: "down", key: "a", code: "KeyA", text: "", modifiers: ["Shift"] });
    await screencast.dispatchInput({ kind: "key", action: "down", key: "", code: "", text: "你好", modifiers: [] });

    expect(dispatched).toEqual([
      { op: "move", x: 720, y: 225 },
      { op: "down", x: 720, y: 225, button: "left" },
      { op: "drag", x: 864, y: 270 },
      { op: "up", x: 864, y: 270, button: "left" },
      { op: "wheel", deltaX: 0, deltaY: 120 },
      { op: "key", action: "down", code: "KeyA", modifiers: ["Shift"] },
      { op: "text", text: "你好" },
    ]);
  });
});
