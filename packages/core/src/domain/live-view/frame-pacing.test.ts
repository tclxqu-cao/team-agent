import { describe, expect, it } from "vitest";
import { LiveViewCapabilityError, LiveViewFramePacer } from "./index.js";

describe("LiveViewFramePacer", () => {
  it("clamps the configured fps into the 2..10 protocol window", () => {
    expect(new LiveViewFramePacer({ fps: 60 }).maxFps).toBe(10);
    expect(new LiveViewFramePacer({ fps: 0 }).maxFps).toBe(2);
    expect(new LiveViewFramePacer({ fps: 4 }).targetFps).toBe(4);
    expect(new LiveViewFramePacer({ fps: 8 }).targetFps).toBe(8);
  });

  it("steps down on rejected or over-budget sends and recovers on a fast streak", () => {
    const pacer = new LiveViewFramePacer({ fps: 5 });
    pacer.recordSend({ accepted: false }, 10);
    expect(pacer.targetFps).toBe(4);
    pacer.recordSend(null, 900);
    expect(pacer.targetFps).toBe(3);
    // floor at 2 even under sustained backpressure
    pacer.recordSend({ accepted: false }, 10);
    pacer.recordSend({ accepted: false }, 10);
    expect(pacer.targetFps).toBe(2);
    // recovery needs 2*targetFps consecutive fast frames
    for (let i = 0; i < 4; i++) pacer.recordSend(undefined, 10);
    expect(pacer.targetFps).toBe(3);
  });
});

describe("LiveViewCapabilityError", () => {
  it("carries the wire-stable capability code", () => {
    const error = new LiveViewCapabilityError("no capture source");
    expect(error.code).toBe("BROWSER_LIVE_STREAM_UNAVAILABLE");
    expect(error.name).toBe("LiveViewCapabilityError");
    expect(error instanceof Error).toBe(true);
  });
});
