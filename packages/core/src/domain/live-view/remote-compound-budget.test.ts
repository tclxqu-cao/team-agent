import { describe, expect, it } from "vitest";
import { RemoteCompoundBudgetPolicy } from "./remote-compound-budget.js";
import { remoteVideoEncodeAdmission } from "./remote-video-encode-admission.js";

describe("compound demand and pressure allocation", () => {
  it("returns idle bandwidth to video, discovers demand quickly and decays without new work", () => {
    const policy = new RemoteCompoundBudgetPolicy();
    expect(policy.allocation(8_000_000, true, 0)).toEqual({ videoBitRate: 7_936_000, patchBytesPerSecond: 8_000 });
    policy.noteDemand(48_000, 100);
    const busy = policy.allocation(8_000_000, true, 100);
    expect(busy).toEqual({ videoBitRate: 6_400_000, patchBytesPerSecond: 200_000 });
    policy.noteDemand(0, 850);
    expect(policy.allocation(8_000_000, true, 850)).toEqual(busy);
    expect(policy.allocation(8_000_000, true, 1600).patchBytesPerSecond).toBeLessThan(busy.patchBytesPerSecond);
    expect(policy.allocation(8_000_000, true, 2350).patchBytesPerSecond).toBe(8000);
  });

  it("limits patches during real pressure, recovers after expiry and ignores RTT alone", () => {
    const policy = new RemoteCompoundBudgetPolicy(); policy.noteDemand(48_000, 0);
    policy.observe({ network: { rttMs: 1500 } }, 0);
    expect(policy.allocation(8_000_000, true, 0).patchBytesPerSecond).toBe(200_000);
    policy.observe({ network: { lossRate: 0.04 } }, 0);
    expect(policy.allocation(8_000_000, true, 0).patchBytesPerSecond).toBe(40_000);
    policy.observe({ network: { lossRate: 0.15 } }, 0);
    expect(policy.allocation(8_000_000, true, 0).patchBytesPerSecond).toBe(20_000);
    policy.noteDemand(48_000, 3001);
    expect(policy.allocation(8_000_000, true, 3001).patchBytesPerSecond).toBe(200_000);
    policy.observe({ encoder: { sampledAt: 3001, encodeLatencyMs: 100 } }, 3001);
    expect(policy.allocation(8_000_000, true, 3001).patchBytesPerSecond).toBe(40_000);
  });

  it("conserves the total and preserves minimum H264 capacity over all supported rates", () => {
    const policy = new RemoteCompoundBudgetPolicy(); policy.noteDemand(48_000, 0);
    for (const rate of [250_000, 499_999, 500_000, 1_000_000, 8_000_000, 20_000_000]) {
      const result = policy.allocation(rate, true, 0);
      expect(result.videoBitRate + result.patchBytesPerSecond * 8).toBe(rate);
      expect(result.videoBitRate).toBeGreaterThanOrEqual(250_000);
      expect(result.patchBytesPerSecond * 8).toBeLessThanOrEqual(rate * 0.2);
    }
    expect(policy.allocation(8_000_000, false, 0).videoBitRate).toBe(8_000_000);
    expect(policy.allocation(NaN, true, 0)).toEqual({ videoBitRate: 0, patchBytesPerSecond: 0 });
    policy.noteDemand(Infinity, 0);
    expect(policy.allocation(250_000, true, 0).patchBytesPerSecond).toBe(0);
  });

  it("bounds admitted native work independently of intentional frame coalescing", () => {
    expect(remoteVideoEncodeAdmission(30)).toEqual({ maxPendingFrames: 2 });
    expect(remoteVideoEncodeAdmission(20)).toEqual({ maxPendingFrames: 2 });
    for (const fps of [5, 19, 0, NaN, Infinity]) expect(remoteVideoEncodeAdmission(fps)).toEqual({ maxPendingFrames: 1 });
  });
});
