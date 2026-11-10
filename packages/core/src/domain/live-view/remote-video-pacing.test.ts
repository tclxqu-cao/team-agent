import { describe, expect, it } from "vitest";
import { RemoteVideoPacingPolicy } from "./remote-video-pacing.js";

describe("RemoteVideoPacingPolicy", () => {
  it('charges repairs to the total budget and limits their share without starving new video', () => {
    const policy = new RemoteVideoPacingPolicy({ bitRate: 800_000 });
    expect(policy.consumeRepair(1_500, 0)).toBe(true);
    expect(policy.consume(1_500, 0)).toBe(false);
    expect(policy.delayForRepair(1_000, 0)).toBe(50);
    expect(policy.consume(1_000, 8)).toBe(true);
    expect(policy.consumeRepair(1_000, 49)).toBe(false);
    expect(policy.consumeRepair(1_000, 50)).toBe(true);
    policy.setBitRate(400_000, 50);
    expect(policy.delayForRepair(1_000, 50)).toBe(100);
    expect(policy.consumeRepair(NaN, 50)).toBe(false);
    expect(policy.consumeRepair(1_501, 50)).toBe(false);
    expect(policy.consumeRepair(1_500, 10_000)).toBe(true);
    expect(policy.consumeRepair(1_500, 10_000)).toBe(false);
  });
  it("spreads a frame over its byte budget and limits idle or stalled-clock bursts", () => {
    const policy = new RemoteVideoPacingPolicy({ bitRate: 800_000 });
    expect(policy.consume(1_500, 0)).toBe(true);
    expect(policy.delayFor(1_250, 0)).toBe(10);
    expect(policy.consume(1_250, 9)).toBe(false);
    expect(policy.consume(1_250, 10)).toBe(true);
    expect(policy.consume(1_500, 10_000)).toBe(true);
    expect(policy.consume(1_500, 10_000)).toBe(false);
  });

  it("does not grant a catch-up burst on rate changes, invalid values or backwards time", () => {
    const policy = new RemoteVideoPacingPolicy({ bitRate: 800_000 });
    policy.consume(1_500, 0);
    policy.setBitRate(1_600_000, 4);
    expect(policy.delayFor(1_500, 4)).toBe(4);
    policy.setBitRate(NaN, 4);
    policy.setBitRate(Infinity, 4);
    policy.setBitRate(0, 4);
    expect(policy.pacingBitRate).toBe(2_000_000);
    expect(policy.delayFor(1_500, 0)).toBe(4);
    expect(policy.delayFor(NaN, 4)).toBe(Infinity);
    expect(policy.consume(-1, 4)).toBe(false);
    policy.reset(100);
    expect(policy.consume(1_500, 100)).toBe(true);
    expect(policy.consume(1_500, 100)).toBe(false);
  });

  it("bounds queued memory and frame age while allowing a large keyframe time to drain", () => {
    const policy = new RemoteVideoPacingPolicy({ bitRate: 800_000 });
    expect(policy.overloaded({ bytes: 10_000, frames: 8, ageMs: 249 })).toBe(false);
    expect(policy.overloaded({ bytes: 10_000, frames: 9, ageMs: 0 })).toBe(true);
    expect(policy.overloaded({ bytes: 8 * 1_024 * 1_024 + 1, frames: 1, ageMs: 0 })).toBe(true);
    expect(policy.overloaded({ bytes: 1, frames: 1, ageMs: 250 })).toBe(true);
    expect(policy.frameLifetimeMs(100_000, false)).toBe(250);
    expect(policy.frameLifetimeMs(100_000, true)).toBe(1_250);
    expect(policy.frameLifetimeMs(8 * 1_024 * 1_024, true)).toBe(2_000);
  });

  it("requires a new keyframe after dropping a dependency or resetting the stream", () => {
    const policy = new RemoteVideoPacingPolicy();
    expect(policy.acceptFrame(false)).toBe(false);
    expect(policy.acceptFrame(true)).toBe(true);
    expect(policy.acceptFrame(false)).toBe(true);
    policy.requireKeyframe();
    expect(policy.acceptFrame(false)).toBe(false);
    expect(policy.acceptFrame(true)).toBe(true);
    policy.reset(1_000);
    expect(policy.waitingForKeyframe).toBe(true);
  });
});
