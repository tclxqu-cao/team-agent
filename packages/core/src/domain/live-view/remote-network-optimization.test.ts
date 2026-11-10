import { describe, expect, it } from 'vitest';
import { RemoteVideoFeedbackPolicy } from './remote-video-feedback.js';
import { RemoteVideoProtectionPolicy } from './remote-video-protection.js';
import { RemoteVideoPlayoutPolicy } from './remote-video-playout.js';
import { RemoteDirectInputPolicy } from './remote-direct-input.js';
import { RemoteVideoPolicy } from './remote-video-policy.js';
import { RemoteVideoPacingPolicy } from './remote-video-pacing.js';
import { RemoteCompoundBudgetPolicy } from './remote-compound-budget.js';

describe('transport feedback qualification', () => {
  it('qualifies busy-path congestion while distinguishing application-limited traffic', () => {
    const policy = new RemoteVideoFeedbackPolicy();
    const sample = { availableBitrate: 2_000_000, sentBytes: 0, targetBitRate: 8_000_000, queueDelayMs: 0, congested: true };
    expect(policy.observe(sample, 0)).toBeNull();
    expect(policy.observe({ ...sample, sentBytes: 30_000 }, 1000)).toMatchObject({ applicationLimited: true, congested: false });
    expect(policy.observe({ ...sample, sentBytes: 1_030_000 }, 2000)).toMatchObject({ applicationLimited: false, congested: true });
    expect(policy.observe({ ...sample, sentBytes: 1_060_000, queueDelayMs: 80 }, 3000)).toMatchObject({ applicationLimited: false, congested: true });
  });
  it('discards sparse, reset, stale and malformed feedback windows', () => {
    const policy = new RemoteVideoFeedbackPolicy();
    const sample = { availableBitrate: 1_000_000, sentBytes: 0, targetBitRate: 8_000_000, queueDelayMs: 0, congested: false };
    policy.observe(sample, 0);
    expect(policy.observe({ ...sample, sentBytes: 100 }, 100)).toBeNull();
    expect(policy.observe({ ...sample, sentBytes: 10 }, 200)).toBeNull();
    expect(policy.observe({ ...sample, sentBytes: 100_000 }, 4000)).toBeNull();
    expect(policy.observe({ ...sample, availableBitrate: NaN }, 5000)).toBeNull();
    policy.reset(); expect(policy.observe({ ...sample, sentBytes: 1_000_000 }, 6000)).toBeNull();
  });
  it('does not collapse static desktop FPS on a low application-limited estimate', () => {
    const policy = new RemoteVideoPolicy();
    for (let n = 0; n < 10; n++) policy.update({ now: n * 1000,
      network: { availableOutgoingBitrate: 100_000, applicationLimited: true, congested: true, lossRate: 0, rttMs: 5 } });
    expect(policy.current()).toMatchObject({ bitRate: 8_000_000, maxFps: 30 });
    expect(policy.update({ network: { availableOutgoingBitrate: 3_000_000, congested: true, applicationLimited: false } }).bitRate).toBeLessThan(8_000_000);
  });
  it('uses real loss without treating application-limited throughput as a bitrate ceiling', () => {
    const policy = new RemoteVideoPolicy();
    const next = policy.update({ network: { lossRate: .06, applicationLimited: true, availableOutgoingBitrate: 100_000 } });
    expect(next.bitRate).toBe(6_560_000);
    const patches = new RemoteCompoundBudgetPolicy(); patches.noteDemand(48_000, 0);
    patches.observe({ network: { applicationLimited: true, availableOutgoingBitrate: 100_000, lossRate: 0 } }, 0);
    expect(patches.allocation(8_000_000, true, 0).patchBytesPerSecond).toBeGreaterThan(40_000);
  });
});

describe('measured protection allocation', () => {
  it('reserves actual repair cost without recursively shrinking or exceeding the nominal budget', () => {
    const policy = new RemoteVideoProtectionPolicy();
    expect(policy.allocation(8_000_000)).toEqual({ videoBitRate: 8_000_000, reservedBitRate: 0, repairBitRate: 1_600_000 });
    policy.observe({ sentBytes: 0, repairedBytes: 0 }, {}, 0);
    policy.observe({ sentBytes: 800_000, repairedBytes: 200_000, queuedRepairBytes: 1_200 }, { lossRate: .15 }, 1000);
    const allocated = policy.allocation(8_000_000);
    expect(allocated.reservedBitRate).toBe(1_920_000);
    expect(allocated.videoBitRate + allocated.reservedBitRate).toBe(8_000_000);
    expect(allocated.repairBitRate).toBeLessThanOrEqual(2_400_000);
    expect(policy.allocation(8_000_000)).toEqual(allocated);
    expect(policy.allocation(1_000_000).reservedBitRate).toBeLessThanOrEqual(250_000);
    policy.observe({ sentBytes: 1_800_000, repairedBytes: 200_000 }, { lossRate: 0 }, 2000);
    expect(policy.allocation(8_000_000).reservedBitRate).toBeLessThan(allocated.reservedBitRate);
    policy.reset(); expect(policy.allocation(8_000_000).reservedBitRate).toBe(0);
  });
  it('ignores no-traffic, stale and reset counter samples', () => {
    const policy = new RemoteVideoProtectionPolicy();
    policy.observe({ sentBytes: 0, repairedBytes: 0 }, {}, 0);
    policy.observe({ sentBytes: 0, repairedBytes: 1_000_000 }, {}, 6000);
    expect(policy.allocation(8_000_000).reservedBitRate).toBe(0);
    policy.observe({ sentBytes: 0, repairedBytes: 0 }, {}, 7000);
    policy.observe({ sentBytes: 0, repairedBytes: 0 }, {}, 8000);
    expect(policy.allocation(8_000_000).reservedBitRate).toBe(0);
  });
  it('updates repair pacing without minting credit or exceeding the aggregate budget', () => {
    const policy = new RemoteVideoPacingPolicy({ bitRate: 800_000 });
    policy.consumeRepair(1500, 0); policy.setRepairBitRate(80_000, 0);
    expect(policy.delayForRepair(1000, 0)).toBe(100);
    expect(policy.consume(1000, 8)).toBe(true);
    policy.setRepairBitRate(160_000, 50);
    expect(policy.delayForRepair(1000, 50)).toBe(25);
    policy.setBitRate(100_000, 50); policy.setRepairBitRate(100_000_000, 50);
    expect(policy.consumeRepair(1500, 50)).toBe(false);
  });
});

describe('playout target policy', () => {
  it('raises network headroom quickly and reduces it slowly within bounds', () => {
    const policy = new RemoteVideoPlayoutPolicy();
    const sample = { sequence: 1, visible: true, intervalMs: 1000, decodedFrames: 30, jitterBufferMs: 100, decodeMs: 5, droppedRatio: 0 };
    expect(policy.observe(sample, 40, 1000)).toBe(100);
    expect(policy.observe({ ...sample, sequence: 2 }, 0, 2000)).toBe(100);
    expect(policy.observe({ ...sample, sequence: 3 }, 0, 3000)).toBe(100);
    expect(policy.observe({ ...sample, sequence: 4 }, 0, 4000)).toBe(90);
    expect(policy.observe({ ...sample, sequence: 5, jitterBufferMinimumMs: 500 }, 300, 5000)).toBe(150);
  });
  it('does not feed an earlier browser minimum back into the requested target', () => {
    const policy = new RemoteVideoPlayoutPolicy();
    const sample = { sequence: 1, visible: true, intervalMs: 1000, decodedFrames: 30, jitterBufferMs: 180,
      jitterBufferMinimumMs: 180, decodeMs: 5, droppedRatio: 0 };
    expect(policy.observe(sample, 0, 1000)).toBe(40);
    policy.observe({ ...sample, sequence: 2 }, 0, 2000);
    expect(policy.observe({ ...sample, sequence: 3 }, 0, 3000)).toBe(30);
    expect(policy.observe({ ...sample, sequence: 4 }, 100, 4000)).toBe(150);
  });
  it('does not act on hidden, missing, duplicate or insufficient evidence', () => {
    const policy = new RemoteVideoPlayoutPolicy();
    expect(policy.observe({ sequence: 1, visible: false }, 100, 1000)).toBeUndefined();
    expect(policy.observe({ sequence: 2, visible: true, intervalMs: 1000, decodedFrames: 0, jitterBufferMs: 100 }, 100, 2000)).toBeUndefined();
  });
});

describe('direct input sequence barriers', () => {
  it('drops reordered hover events across reliable actions and accepts the next generation of moves', () => {
    const policy = new RemoteDirectInputPolicy('stream-1234567890');
    const move = { stream: policy.stream, sequence: 1, barrier: 0, x: .2, y: .3 };
    expect(policy.acceptMove(move)).toBe(true);
    expect(policy.acceptMove(move)).toBe(false);
    expect(policy.acceptMove({ ...move, sequence: 3, barrier: 2 })).toBe(false);
    expect(policy.acceptReliable({ stream: policy.stream, sequence: 2 })).toBe(true);
    expect(policy.acceptMove({ ...move, sequence: 3 })).toBe(false);
    expect(policy.acceptMove({ ...move, sequence: 3, barrier: 2 })).toBe(true);
    expect(policy.acceptMove({ ...move, sequence: 4, barrier: 2, stream: 'old' })).toBe(false);
    expect(policy.acceptMove({ ...move, sequence: 4, barrier: 2, x: NaN })).toBe(false);
  });
});
