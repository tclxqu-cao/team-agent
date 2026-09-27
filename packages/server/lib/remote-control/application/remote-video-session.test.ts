import { describe, expect, it, vi } from 'vitest';
import { RemoteVideoPolicy } from '@agent/core';
// @ts-expect-error gateway ESM
import { RemoteVideoSession } from './remote-video-session.mjs';

function fixture({ failHigh = false, failBaselineTransport = false } = {}) {
  let options: any;
  const transports: any[] = [];
  const frameListeners: Array<(frame: any) => void> = [];
  const encoder = {
    capabilities: () => ({ dynamicBitrate: true, dynamicFrameRate: true, encoderQueueTelemetry: true, explicitH264Profile: true, codecPreferences: ['high', 'baseline'] as const }),
    onFrame: vi.fn((listener) => {
      frameListeners.push(listener);
      return () => undefined;
    }),
    start: vi.fn(async ({ profile }) => { if (failHigh && profile === 'high') throw new Error('High unavailable'); }),
    apply: vi.fn(async () => undefined), snapshot: vi.fn(async () => null),
    requestKeyframe: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
  };
  const transportFactory = vi.fn((input) => {
    options = input;
    const transport = {
      connected: false, peer: { id: transports.length + 1 },
      start: vi.fn(async (profile) => {
        if (failBaselineTransport && profile === 'baseline') throw new Error('Baseline transport unavailable');
      }), answer: vi.fn(async () => undefined), addIceCandidate: vi.fn(async () => undefined),
      send: vi.fn(() => true), snapshot: vi.fn(async () => null), stop: vi.fn(async () => undefined),
    };
    transports.push(transport);
    return transport;
  });
  const signal = vi.fn();
  const logger = { info: vi.fn() };
  const policy = new RemoteVideoPolicy('hd', encoder.capabilities());
  const session = new RemoteVideoSession({ encoder, signal, policy, transportFactory, logger, iceConfig: { iceServers: [], warning: null } });
  return { session, encoder, signal, logger, transports, frameListeners, transportFactory, state: (value: string) => options.onState(value) };
}

describe('RemoteVideoSession', () => {
  it('counts feedback once per sampling interval, then expires it', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.session.handle({ kind: 'start' });
      f.transports[0].connected = true;
      await f.state('connected');
      for (let n = 0; n < 10; n++) f.session.applyStats({lossRate:0.08,rttMs:280});
      expect(f.session.policy.current().maxFps).toBe(30);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.session.policy.current().maxFps).toBe(30);
      f.session.applyStats({lossRate:0.08,rttMs:280});
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.session.policy.current().maxFps).toBe(15);
      await vi.advanceTimersByTimeAsync(6000);
      expect(f.session.policy.current().maxFps).toBe(15);
    } finally { await f.session.stop(); vi.useRealTimers(); }
  });
  it('uses receiver capabilities and falls back from High exactly once', async () => {
    const f = fixture({ failHigh: true });
    await f.session.handle({ kind: 'start', receiverProfiles: ['high', 'baseline'] });
    expect(f.transports[0].start).toHaveBeenCalledWith('high');
    f.transports[0].connected = true;
    await f.state('connected');
    await vi.waitFor(() => expect(f.transportFactory).toHaveBeenCalledTimes(2));
    expect(f.transports[1].start).toHaveBeenCalledWith('baseline');
    expect(f.signal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'state', state: 'connecting', fallbackReason: 'High unavailable' }));
    f.transports[1].connected = true;
    await f.state('connected');
    expect(f.encoder.start).toHaveBeenLastCalledWith(expect.objectContaining({ profile: 'baseline' }));
    f.frameListeners[0]({ nals: [Buffer.from([0x65])], timestamp: 1 });
    expect(f.transports[1].send).not.toHaveBeenCalled();
    f.frameListeners[1]({ nals: [Buffer.from([0x65])], timestamp: 2 });
    expect(f.transports[1].send).toHaveBeenCalledOnce();
    await f.session.stop();
  });

  it('coalesces queued tuning and ignores receiver stats before connection', async () => {
    const f = fixture();
    await f.session.handle({ kind: 'stats', lossRate: 0.2, rttMs: 600 });
    expect(f.encoder.apply).not.toHaveBeenCalled();
    f.session.applyTuning(f.session.policy.current('one'));
    f.session.applyTuning({ ...f.session.policy.current('two'), bitRate: 4_000_000 });
    await f.session.tuningChain;
    expect(f.encoder.apply).toHaveBeenLastCalledWith(expect.objectContaining({ bitRate: 4_000_000 }));
  });

  it('wakes video tuning without blocking input and deduplicates sanitized logs', async () => {
    const f = fixture();
    let releaseApply!: () => void;
    f.encoder.apply.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseApply = resolve; }));

    expect(f.session.noteInteraction()).toMatchObject({ maxFps: 30, reason: 'interaction' });
    expect(f.session.noteInteraction()).toMatchObject({ maxFps: 30, reason: 'interaction' });
    await vi.waitFor(() => expect(releaseApply).toBeTypeOf('function'));
    expect(f.encoder.apply).toHaveBeenCalledTimes(1);
    expect(f.logger.info).toHaveBeenCalledTimes(1);
    expect(f.logger.info).toHaveBeenCalledWith('remote video decision', expect.objectContaining({
      trigger: 'interaction', targetFps: 30, reason: 'interaction',
    }));
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain('sdp');
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain('candidate');

    releaseApply();
    await f.session.tuningChain;
  });

  it('logs adaptive telemetry only when material values change', () => {
    const f = fixture();
    f.session.applyStats({ lossRate: 0, rttMs: 2, droppedFrames: 0, availableBitrate: 20_000_000 });
    f.session.applyStats({ lossRate: 0, rttMs: 2, droppedFrames: 0, availableBitrate: 20_000_000 });
    expect(f.logger.info).toHaveBeenCalledTimes(1);
    expect(f.logger.info).toHaveBeenCalledWith('remote video decision', expect.objectContaining({
      trigger: 'receiver-stats', rttMs: 2, lossRate: 0, availableBitrate: 20_000_000,
    }));
    f.session.applyStats({ lossRate: 0.06, rttMs: 280, droppedFrames: 1, availableBitrate: 4_000_000 });
    expect(f.logger.info).toHaveBeenCalledTimes(2);
  });

  it('reports a Baseline startup failure reached through the High fallback', async () => {
    const f = fixture({ failHigh: true, failBaselineTransport: true });
    await f.session.handle({ kind: 'start', receiverProfiles: ['high', 'baseline'] });
    f.transports[0].connected = true;
    await f.state('connected');
    await vi.waitFor(() => expect(f.signal).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'state', state: 'failed', error: 'Baseline transport unavailable',
    })));
  });

  it('keeps static sessions alive while helper keyframe probes succeed', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.session.handle({ kind: 'start', receiverProfiles: ['baseline'] });
      const transport = f.transports[0]; transport.connected = true;
      await f.state('connected');
      f.session.onFrame({ nalUnits: [Buffer.from([0x65])], timestampUs: 1 }, f.session.generation, transport);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.encoder.requestKeyframe).toHaveBeenCalledTimes(3);
      expect(f.signal).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }));
    } finally {
      await f.session.stop(); vi.useRealTimers();
    }
  });
});
