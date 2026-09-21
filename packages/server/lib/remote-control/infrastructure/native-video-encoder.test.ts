import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error gateway ESM
import { NativeVideoEncoder } from './native-video-encoder.mjs';

describe('NativeVideoEncoder', () => {
  it('declares native capabilities and maps decisions to helper commands', async () => {
    const helper = { request: vi.fn(async () => ({ ok: true })), onVideo: vi.fn(() => () => undefined) };
    const encoder = new NativeVideoEncoder({ helper, highProfile: true });
    expect(encoder.capabilities()).toMatchObject({ encoderQueueTelemetry: true, codecPreferences: ['high', 'baseline'] });
    await encoder.start({ profile: 'high', decision: { bitRate: 8_000_000, maxFps: 30 } });
    expect(helper.request).toHaveBeenCalledWith({ op: 'video-start', profile: 'high', bitRate: 8_000_000, maxFps: 30 });
  });

  it('normalizes stats and treats unavailable telemetry as unsupported', async () => {
    const helper = { request: vi.fn(async ({ op }) => op === 'video-stats' ? {
      ok: true, pendingFrames: 3, encodeLatencyMs: 20, droppedFrames: 1, sequence: 4,
      sampledAt: 100, activity: 'interactive', activityConfidence: 0.8,
    } : { ok: true }) };
    const encoder = new NativeVideoEncoder({ helper });
    await expect(encoder.snapshot()).resolves.toEqual({
      telemetry: { pendingFrames: 3, encodeLatencyMs: 20, droppedFrames: 1, sequence: 4, sampledAt: 100 },
      content: { activity: 'interactive', confidence: 0.8, observedAt: 100 },
    });
    helper.request.mockRejectedValueOnce(new Error('unsupported'));
    await expect(encoder.snapshot()).resolves.toBeNull();
  });

  it('does not hide a High startup failure but supports legacy Baseline helpers', async () => {
    const helper = { request: vi.fn(async ({ op }) => { if (op === 'video-start') throw new Error('unsupported profile'); return { ok: true }; }) };
    const encoder = new NativeVideoEncoder({ helper });
    await expect(encoder.start({ profile: 'high', decision: { bitRate: 1, maxFps: 5 } })).rejects.toThrow('unsupported profile');
    await expect(encoder.start({ profile: 'baseline', decision: { bitRate: 1_000_000, maxFps: 15 } })).resolves.toBeUndefined();
    expect(helper.request).toHaveBeenCalledWith({ op: 'video', enabled: true });
  });
});
