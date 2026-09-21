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
  const policy = new RemoteVideoPolicy('hd', encoder.capabilities());
  const session = new RemoteVideoSession({ encoder, signal, policy, transportFactory, iceConfig: { iceServers: [], warning: null } });
  return { session, encoder, signal, transports, frameListeners, transportFactory, state: (value: string) => options.onState(value) };
}

describe('RemoteVideoSession', () => {
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
