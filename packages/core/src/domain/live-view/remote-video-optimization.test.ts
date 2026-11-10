import { describe, expect, it } from "vitest";
import { RemoteCompoundQualityPolicy, compoundWindowLimits } from "./remote-compound-quality.js";
import { RemoteInputCoalescer } from "./remote-input-coalescer.js";
import { RemoteFrameQoe } from "./remote-frame-qoe.js";
import { remoteVideoKeyframeInterval } from "./remote-video-encode-admission.js";

const frame = { epoch: "e", revision: 1, timestamp: 1, width: 128, height: 128 };

describe("remote optimization policies", () => {
  it("excludes in-flight placements before limiting repair work and wakes only damaged blocks", () => {
    const policy = new RemoteCompoundQualityPolicy(); policy.invalidate(frame, undefined, 0);
    expect(policy.priorities(1, 2, [{ x: 0, y: 0 }, { x: 64, y: 0 }])).toEqual([2, 3]);
    policy.acknowledge([{ x: 0, y: 0 }, { x: 64, y: 0 }, { x: 0, y: 64 }, { x: 64, y: 64 }]);
    expect(policy.priorities(2)).toEqual([]);
    policy.invalidate({ ...frame, revision: 2 }, [{ x: 64, y: 64, width: 64, height: 64 }], 3);
    expect(policy.priorities(4)).toEqual([3]);
  });
  it("prioritizes interaction repairs, backs off probed blocks and suppresses acknowledged sharp blocks", () => {
    const policy = new RemoteCompoundQualityPolicy(); policy.invalidate(frame, undefined, 0);
    policy.noteInteraction({ x: 0.9, y: 0.9 }, 10);
    expect(policy.priorities(20)[0]).toBe(3);
    policy.attempted([3], 20); expect(policy.priorities(21)[0]).not.toBe(3);
    policy.acknowledge([{ x: 0, y: 0 }]); expect(policy.priorities(22)).not.toContain(0);
    policy.invalidate({ ...frame, revision: 2 }, [{ x: 64, y: 64, width: 64, height: 64 }], 30);
    expect(policy.isSharp({ x: 0, y: 0 })).toBe(true);
    policy.observe("idle"); expect(policy.entropyLimit(2000)).toBe(24);
    policy.noteInteraction(undefined, 2000); expect(policy.entropyLimit(2001)).toBe(6.3);
  });
  it("only clears repair debt for scroll blocks whose entire source was confirmed sharp", () => {
    const policy = new RemoteCompoundQualityPolicy(); policy.invalidate(frame, undefined, 0);
    policy.acknowledge([{ x: 0, y: 0 }, { x: 64, y: 0 }, { x: 0, y: 64 }, { x: 64, y: 64 }]);
    policy.invalidate({ ...frame, revision: 2 }, undefined, 1);
    const copy = { sourceRevision: 1, sourceX: 0, sourceY: 17, x: 0, y: 0, width: 128, height: 111 };
    expect(policy.acknowledgeScroll(copy)).toEqual([{ x: 0, y: 0 }, { x: 64, y: 0 }]);
    expect(policy.priorities(3).sort()).toEqual([2, 3]);
    expect(policy.acknowledgeScroll({ ...copy, sourceRevision: 0 })).toEqual([]);
  });
  it("coalesces adjacent hover positions while retaining drag and key/button boundaries", () => {
    const queue = new RemoteInputCoalescer<number>();
    queue.offer(1, "hover"); expect(queue.offer(2, "hover")).toEqual({ replaced: 1 });
    queue.offer(3, "down"); queue.offer(4, "hover"); queue.offer(5, "hover"); queue.offer(6, "up");
    queue.offer(7, "barrier"); queue.offer(8, "hover"); queue.offer(9, "hover");
    expect(queue.reset()).toEqual([2, 3, 4, 5, 6, 7, 9]); expect(queue.size).toBe(0);
  });
  it("distinguishes feedback RTT from clock-corrected capture-to-presentation estimates", () => {
    const qoe = new RemoteFrameQoe();
    expect(qoe.synchronize(0, 110, 110, 20)).toBe(true);
    qoe.sent(1, 40, 30); expect(qoe.presented(1, 180, 100)).toBe(true);
    expect(qoe.snapshot()).toMatchObject({ feedbackP95Ms: 60, captureToPresentationP95Ms: 50, clockUncertaintyMs: 10 });
    qoe.sent(1, 100, 90); expect(qoe.presented(1, 200, 120)).toBe(false);
    expect(qoe.presented(999, 200, 120)).toBe(false);
    expect(qoe.synchronize(20, 100, 90, 30)).toBe(false);
    const uncalibrated = new RemoteFrameQoe(); uncalibrated.sent(2, 0, 0); uncalibrated.presented(2, 10000, 30);
    expect(uncalibrated.snapshot().captureToPresentationP95Ms).toBeUndefined();
  });
  it("bounds windows and avoids frequent healthy IDR bursts while shortening recovery GOPs", () => {
    expect(compoundWindowLimits(false, 1000).batches).toBe(1);
    expect(compoundWindowLimits(true, 10000)).toEqual({ batches: 4, bytes: 64_000 });
    expect(remoteVideoKeyframeInterval(30)).toBe(60);
    expect(remoteVideoKeyframeInterval(30, "severe-congestion")).toBe(30);
    expect(remoteVideoKeyframeInterval(5)).toBe(20);
  });
});
