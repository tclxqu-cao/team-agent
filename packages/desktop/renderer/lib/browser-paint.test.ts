import { describe, expect, it, vi } from "vitest";
import { waitForNextPaint, type PaintTarget } from "./browser-paint";

function createPaintTarget() {
  let nextTimerId = 1;
  const frames: FrameRequestCallback[] = [];
  const timers = new Map<number, () => void>();
  const target: PaintTarget = {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }),
    setTimeout: vi.fn((callback: () => void) => {
      const timerId = nextTimerId++;
      timers.set(timerId, callback);
      return timerId;
    }),
    clearTimeout: vi.fn((timerId: number) => {
      timers.delete(timerId);
    }),
  };
  return { frames, target, timers };
}

describe("waitForNextPaint", () => {
  it("resolves from a task scheduled after the next animation frame", async () => {
    const { frames, target, timers } = createPaintTarget();
    let resolved = false;
    const pending = waitForNextPaint(target).then(() => { resolved = true; });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(frames).toHaveLength(1);

    frames[0](16);
    await Promise.resolve();
    expect(resolved).toBe(false);

    const afterFrame = [...timers.entries()].find(([timerId]) => timerId !== 1);
    expect(afterFrame).toBeDefined();
    afterFrame![1]();
    await pending;
    expect(resolved).toBe(true);
  });

  it("falls back when animation frames are throttled", async () => {
    const { target, timers } = createPaintTarget();
    const pending = waitForNextPaint(target);

    expect(timers.get(1)).toBeDefined();
    timers.get(1)!();

    await expect(pending).resolves.toBeUndefined();
  });
});
