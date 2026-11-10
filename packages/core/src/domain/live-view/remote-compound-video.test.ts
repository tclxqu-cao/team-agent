import { describe, expect, it } from "vitest";
import { RemoteCompoundVideoPolicy, isCompoundTile, splitCompoundVideoBitRate, compoundRtpTimestamp, isLaterCompoundRtp } from "./remote-compound-video.js";
import type { CompoundFrameIdentity, CompoundTileDescriptor } from "./remote-compound-video.js";

const frame: CompoundFrameIdentity = { epoch: "one", revision: 1, timestamp: 1, width: 128, height: 64 };
const tile: CompoundTileDescriptor = { key: "a".repeat(64), x: 0, y: 0, width: 64, height: 64, entropy: 3, bytes: 203 };

describe("compound video domain policy", () => {
  it("assigns compact IDs prospectively, commits them only on ACK and resets the namespace", () => {
    const policy = new RemoteCompoundVideoPolicy(); policy.invalidate(frame);
    const cost = { headerBytes: 33, tileBytes: 10, payloadNumerator: 1, payloadDenominator: 1 };
    const plan = policy.plan(frame, [tile, { ...tile, x: 64 }], 256, cost)!;
    expect(plan.tiles.map(tile => [tile.cacheId, tile.mode])).toEqual([[1, "put"], [1, "reuse"]]);
    expect(plan.estimatedBytes).toBe(256);
    expect(policy.plan(frame, [tile], 256)).toBeNull();
    const other = { ...tile, key: "b".repeat(64) };
    expect(policy.plan(frame, [other], 1000)!.tiles[0].cacheId).toBe(1);
    policy.acknowledge(plan);
    expect(policy.plan(frame, [other], 1000)!.tiles[0].cacheId).toBe(2);
    policy.resetCache();
    expect(policy.plan(frame, [other], 1000)!.tiles[0].cacheId).toBe(1);
  });

  it("never reassigns a sent but unacknowledged slot after content invalidation", () => {
    const policy = new RemoteCompoundVideoPolicy(); policy.invalidate(frame);
    const sent = policy.plan(frame, [tile], 4096)!;
    policy.markSent(sent);
    const next = { ...frame, revision: 2 }; policy.invalidate(next);
    expect(policy.acknowledge(sent)).toBe(false);
    const retry = policy.plan(next, [tile, { ...tile, key: "b".repeat(64), x: 64 }], 4096)!;
    expect(retry.tiles.map(tile => [tile.cacheId, tile.mode])).toEqual([[2, "put"], [3, "put"]]);
    policy.markSent(retry); policy.acknowledge(retry);
    policy.invalidate({ ...next, revision: 3 });
    expect(policy.plan({ ...next, revision: 3 }, [tile], 4096)!.tiles[0]).toMatchObject({ cacheId: 2, mode: "reuse" });
  });
  it("admits lossless updates, suppresses unchanged placements and reuses acknowledged pixels after scrolling", () => {
    const policy = new RemoteCompoundVideoPolicy();
    policy.invalidate(frame);
    const initial = policy.plan(frame, [tile], 4096)!;
    expect(initial.tiles[0].mode).toBe("put");
    expect(policy.plan(frame, [tile], 4096)!.tiles[0].mode).toBe("put");
    expect(policy.acknowledge(initial)).toBe(true);
    expect(policy.plan(frame, [tile], 4096)).toBeNull();
    const scrolled = policy.plan(frame, [{ ...tile, x: 64 }], 4096)!;
    expect(scrolled.tiles[0]).toMatchObject({ mode: "reuse", x: 64 });
    expect(scrolled.estimatedBytes).toBeLessThan(initial.estimatedBytes);
  });

  it("invalidates only damaged placements and keeps other lossless tiles sharp", () => {
    const policy = new RemoteCompoundVideoPolicy();
    policy.invalidate(frame);
    policy.acknowledge(policy.plan(frame, [tile, { ...tile, x: 64 }], 4096)!);
    const next = { ...frame, revision: 2 };
    policy.invalidate(next, [{ x: 0, y: 0, width: 16, height: 16 }]);
    const plan = policy.plan(next, [tile, { ...tile, x: 64 }], 4096)!;
    expect(plan.tiles).toHaveLength(1);
    expect(plan.tiles[0]).toMatchObject({ x: 0, mode: "reuse" });
  });

  it("rejects stale receipts and forgets assets on capture epoch or geometry changes", () => {
    const policy = new RemoteCompoundVideoPolicy();
    policy.invalidate(frame);
    const old = policy.plan(frame, [tile], 4096)!;
    policy.invalidate({ ...frame, revision: 2 });
    expect(policy.acknowledge(old)).toBe(false);
    expect(policy.plan(frame, [tile], 4096)).toBeNull();
    const fresh = { ...frame, epoch: "two" };
    policy.invalidate(fresh);
    expect(policy.plan(fresh, [tile], 4096)!.tiles[0].mode).toBe("put");
    expect(policy.invalidate({ ...fresh, revision: 0 })).toBe(false);
  });

  it("bounds entropy, geometry, duplicate targets and wire budgets", () => {
    const policy = new RemoteCompoundVideoPolicy(); policy.invalidate(frame);
    expect(policy.plan(frame, [tile], 300)).toBeNull();
    expect(policy.plan(frame, [{ ...tile, entropy: 25 }, { ...tile, x: 1 }, { ...tile, width: 129 }], 4096)).toBeNull();
    expect(policy.plan(frame, [tile, tile], 4096)!.tiles).toHaveLength(1);
    expect(isCompoundTile({ ...tile, key: "not-a-hash" }, frame)).toBe(false);
    expect(isCompoundTile({ ...tile, bytes: 100_000 }, frame)).toBe(false);
  });

  it("resets a full decoded-pixel cache rather than growing without bound", () => {
    const policy = new RemoteCompoundVideoPolicy();
    policy.invalidate(frame);
    let plan;
    for (let index = 0; index < 2600; index++) {
      const current = { ...frame, revision: index + 1 };
      policy.invalidate(current);
      plan = policy.plan(current, [{ ...tile, key: index.toString(16).padStart(64, "0") }], 4096)!;
      if (plan.resetRequired) break;
      policy.acknowledge(plan);
    }
    expect(plan?.resetRequired).toBe(true);
    policy.resetCache();
    expect(policy.plan({ ...frame, revision: plan!.frame.revision }, [tile], 4096)!.tiles[0].mode).toBe("put");
  });

  it("reserves enhancement bandwidth within the total allocation and handles RTP wrapping", () => {
    expect(splitCompoundVideoBitRate(8_000_000, true)).toEqual({ videoBitRate: 7_360_000, patchBytesPerSecond: 80_000 });
    expect(splitCompoundVideoBitRate(250_000, true)).toEqual({ videoBitRate: 250_000, patchBytesPerSecond: 0 });
    expect(splitCompoundVideoBitRate(8_000_000, false).videoBitRate).toBe(8_000_000);
    expect(compoundRtpTimestamp(1)).toBe(90_000);
    expect(isLaterCompoundRtp(10, 0xffff_fff0)).toBe(true);
    expect(isLaterCompoundRtp(0xffff_fff0, 10)).toBe(false);
  });
});
