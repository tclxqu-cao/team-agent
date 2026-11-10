import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error gateway ESM
import { NativeVideoEncoder } from './native-video-encoder.mjs';
// @ts-expect-error gateway ESM
import { WindowsRemoteHelper } from '../windows-helper.mjs';
vi.mock('@agent/core', async original => ({ ...await original<Record<string, unknown>>(), ...await import('../../../../core/src/domain/live-view/index.js'), ...await import('../../../../core/src/domain/live-view/remote-video-encode-admission.js') }));

describe('NativeVideoEncoder', () => {
  it('claims adaptive resolution only after a versioned native receipt', async () => {
    const helper = { request: vi.fn(async () => ({ ok: true, adaptiveResolutionVersion: 1 })) };
    const encoder = new NativeVideoEncoder({ helper });
    expect(encoder.capabilities().dynamicResolution).toBe(false);
    await encoder.start({ profile: 'baseline', decision: { bitRate: 8_000_000, maxFps: 30 } });
    expect(encoder.capabilities().dynamicResolution).toBe(true);
    helper.request.mockResolvedValueOnce({ ok: true } as any);
    await encoder.start({ profile: 'baseline', decision: { bitRate: 8_000_000, maxFps: 30 } });
    expect(encoder.capabilities().dynamicResolution).toBe(false);
  });

  it('forwards adaptive size caps and an explicit native-size restore', async () => {
    const helper = { request: vi.fn(async () => ({ ok: true })) };
    const encoder = new NativeVideoEncoder({ helper });
    await encoder.start({ profile: 'baseline', decision: { bitRate: 8_000_000, maxFps: 30, maxEdge: 1280 } });
    expect(helper.request).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'video-start', maxEdge: 1280 }));
    helper.request.mockRejectedValueOnce(new Error('transient IPC'));
    await expect(encoder.apply({ bitRate: 8_000_000, maxFps: 30 })).rejects.toThrow('transient IPC');
    await encoder.apply({ bitRate: 8_000_000, maxFps: 30 });
    expect(helper.request).toHaveBeenLastCalledWith(expect.objectContaining({ op: 'video-tuning', maxEdge: 0 }));
  });

  it('passes selected repair blocks to native helpers while keeping legacy sweep defaults', async () => {
    const helper = { request: vi.fn(async () => ({ stale: true })) };
    const encoder = new NativeVideoEncoder({ helper });
    await encoder.sampleCompound(48000, { priorityIndices: [3], selectedOnly: true, maxEntropy: 24 });
    expect(helper.request).toHaveBeenLastCalledWith({ op: 'compound-sample', maxBytes: 48000, maxEntropy: 24, priorityIndices: [3], selectedOnly: true });
    await encoder.sampleCompound(48000);
    expect(helper.request.mock.calls.at(-1)?.[0]).not.toHaveProperty('selectedOnly');
  });
  it('declares native capabilities and maps decisions to helper commands', async () => {
    const helper = { request: vi.fn(async () => ({ ok: true })), onVideo: vi.fn(() => () => undefined) };
    const encoder = new NativeVideoEncoder({ helper, highProfile: true });
    expect(encoder.capabilities()).toMatchObject({ encoderQueueTelemetry: true, codecPreferences: ['high', 'baseline'] });
    await encoder.start({ profile: 'high', decision: { bitRate: 8_000_000, maxFps: 30 } });
    expect(helper.request).toHaveBeenCalledWith({ op: 'video-start', profile: 'high', bitRate: 8_000_000, maxFps: 30, maxPendingFrames: 2, keyFrameInterval: 60 });
    await encoder.apply({ bitRate: 1_000_000, maxFps: 5 });
    expect(helper.request).toHaveBeenLastCalledWith({ op: 'video-tuning', bitRate: 1_000_000, maxFps: 5, maxPendingFrames: 1, keyFrameInterval: 20 });
  });

  it('normalizes stats and treats unavailable telemetry as unsupported', async () => {
    const helper = { request: vi.fn(async ({ op }) => op === 'video-stats' ? {
      ok: true, pendingFrames: 2, queuedFrames: 1, coalescedFrames: 9, admissionLimit: 2, encodeLatencyMs: 20, droppedFrames: 1, sequence: 4,
      sampledAt: 100, activity: 'interactive', activityConfidence: 0.8,
    } : { ok: true }) };
    const encoder = new NativeVideoEncoder({ helper });
    await expect(encoder.snapshot()).resolves.toEqual({
      telemetry: { pendingFrames: 2, queuedFrames: 1, coalescedFrames: 9, admissionLimit: 2, encodeLatencyMs: 20, droppedFrames: 1, sequence: 4, sampledAt: 100 },
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
    expect(encoder.capabilities()).toMatchObject({ dynamicBitrate: false, dynamicFrameRate: false });
  });

  it('keeps the shipped Windows helper on supported Baseline commands without claiming dynamic or compound support', async () => {
    const helper = new WindowsRemoteHelper({ executable: 'unused-test-helper.exe' });
    const request = vi.spyOn(helper, 'request').mockImplementation(async (cmd: any) => {
      if (cmd.op === 'video') return { ok: true };
      throw new Error('Unknown input operation');
    });
    const encoder = new NativeVideoEncoder({ helper, highProfile: false });
    expect(encoder.capabilities()).toMatchObject({ codecPreferences: ['baseline'], dynamicBitrate: false,
      dynamicFrameRate: false, encoderQueueTelemetry: false, explicitH264Profile: false, compoundVideo: false });
    await encoder.start({ profile: 'baseline', decision: { bitRate: 8_000_000, maxFps: 30 } });
    await encoder.apply({ bitRate: 4_000_000, maxFps: 15 });
    await expect(encoder.snapshot()).resolves.toBeNull();
    expect(request.mock.calls.map(([cmd]) => cmd)).toEqual([{ op: 'video', enabled: true }]);
    await expect(encoder.start({ profile: 'high', decision: {} })).rejects.toThrow('Baseline only');
    await encoder.stop();
    expect(request).toHaveBeenLastCalledWith({ op: 'video', enabled: false });
  });
});
