import { describe, expect, it, vi } from 'vitest';
// Exercise the current policy rather than whichever core bundle was last built.
import { RemoteVideoPolicy } from '../../../../core/src/domain/live-view/remote-video-policy.js';
// @ts-expect-error gateway ESM
import { RemoteVideoSession } from './remote-video-session.mjs';

vi.mock('@agent/core', async original => ({ ...await original<Record<string, unknown>>(), ...await import('../../../../core/src/domain/live-view/index.js'), ...await import('../../../../core/src/domain/live-view/remote-compound-video.js'), ...await import('../../../../core/src/domain/live-view/remote-compound-budget.js'), ...await import('../../../../core/src/domain/live-view/remote-video-encode-admission.js') }));

function fixture({ failHigh = false, failBaselineTransport = false, log = vi.fn(), compound = false } = {}) {
  let options: any;
  const transports: any[] = [];
  const frameListeners: Array<(frame: any) => void> = [];
  const encoder = {
    capabilities: () => ({ dynamicBitrate: true, dynamicFrameRate: true, encoderQueueTelemetry: true, explicitH264Profile: true, codecPreferences: ['high', 'baseline'] as const, compoundVideo: compound }),
    onCompound: vi.fn(() => () => undefined), enableCompound: vi.fn(async () => undefined), sampleCompound: vi.fn(async () => null),
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
      setTuning: vi.fn(), pause: vi.fn(), resume: vi.fn(), feedback: input.onFeedback, delivered: input.onFrameSent,
    };
    transports.push(transport);
    return transport;
  });
  const signal = vi.fn();
  const policy = new RemoteVideoPolicy('hd', encoder.capabilities());
  const session = new RemoteVideoSession({ encoder, signal, policy, transportFactory, iceConfig: { iceServers: [], warning: null }, log });
  return { session, encoder, signal, log, transports, frameListeners, transportFactory, state: (value: string) => options.onState(value) };
}

describe('RemoteVideoSession', () => {
  it('seeds before encoder start and adjusts repair budget at 250ms without extra native snapshots', async () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      await f.session.handle({ kind: 'start' }); const transport = f.transports[0];
      let counters = { sentBytes: 0, repairedBytes: 0, queuedRepairBytes: 0 };
      transport.protectionSample = () => counters;
      transport.networkSample = () => ({ lossRate: .1 });
      transport.connected = true; await f.state('connected');
      counters = { sentBytes: 200_000, repairedBytes: 50_000, queuedRepairBytes: 10_000 };
      await vi.advanceTimersByTimeAsync(250); await f.session.tuningChain;
      expect(f.session.protection.allocation(8_000_000).reservedBitRate).toBe(1_920_000);
      expect(f.encoder.snapshot).not.toHaveBeenCalled();
      f.session.pause(); counters = { sentBytes: 2_000_000, repairedBytes: 1_000_000, queuedRepairBytes: 0 };
      await vi.advanceTimersByTimeAsync(3_000); await f.session.resume();
      await vi.advanceTimersByTimeAsync(250);
      expect(f.session.protection.allocation(8_000_000).reservedBitRate).toBe(1_920_000);
      counters = { sentBytes: 2_200_000, repairedBytes: 1_050_000, queuedRepairBytes: 10_000 };
      await vi.advanceTimersByTimeAsync(250);
      expect(f.session.protection.allocation(8_000_000).reservedBitRate).toBeLessThanOrEqual(1_920_000);
    } finally { await f.session.stop(); vi.useRealTimers(); }
  });
  it('deducts measured recovery before patch allocation and configures the shared sender budget', async () => {
    const f = fixture({ compound: true });
    try {
      f.session.protection.observe({ sentBytes: 0, repairedBytes: 0 }, {}, 0);
      f.session.protection.observe({ sentBytes: 800_000, repairedBytes: 200_000, queuedRepairBytes: 10_000 }, {}, 1000);
      // A connected transport is not needed to verify allocation through the composition ports.
      const setTuning = vi.fn(); f.session.transport = { connected: false, setTuning, stop: vi.fn() };
      f.session.applyTuning(f.session.policy.current()); await f.session.tuningChain;
      expect(f.encoder.apply).toHaveBeenLastCalledWith(expect.objectContaining({ bitRate: 6_080_000 }));
      expect(setTuning).toHaveBeenLastCalledWith(expect.objectContaining({ bitRate: 6_080_000, pacingBitRate: 8_000_000 }));
      f.session.applyTuning(f.session.policy.current()); await f.session.tuningChain;
      expect(f.encoder.apply).toHaveBeenLastCalledWith(expect.objectContaining({ bitRate: 6_080_000 }));
    } finally { await f.session.stop(); }
  });
  it('separates receiver frame drops from transport loss and applies CPU caps without reducing bitrate', async () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      await f.session.handle({ kind: 'start' }); f.transports[0].connected = true; await f.state('connected');
      for (let n = 1; n <= 3; n++) {
        await f.session.handle({ kind: 'stats', droppedFrames: 100, lossRate: 0, rttMs: 10,
          receiver: { sequence: n, visible: true, intervalMs: 1000, decodedFrames: 20, decodeMs: 100, droppedRatio: .2 } });
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(f.session.policy.current()).toMatchObject({ bitRate: 8_000_000, maxFps: 5 });
      await f.session.tuningChain;
      expect(f.encoder.apply).toHaveBeenLastCalledWith(expect.objectContaining({ bitRate: 8_000_000, maxFps: 5 }));
    } finally { await f.session.stop(); vi.useRealTimers(); }
  });

  it('marks first-frame readiness and sent counters only after the paced frame has finished', async () => {
    const f = fixture();
    try {
      await f.session.handle({ kind: 'start', receiverProfiles: ['baseline'] });
      const transport = f.transports[0]; transport.connected = true; transport.reportsFrameDelivery = true;
      await f.state('connected');
      f.frameListeners[0]({ nals: [Buffer.from([0x65, 1])], timestamp: 1 });
      expect(f.session.framesQueued).toBe(1);
      expect(f.session.framesSent).toBe(0);
      expect(f.session.firstFrameSeen).toBe(false);
      transport.delivered({ timestamp: 1, key: true, bytes: 2 });
      expect(f.session.framesSent).toBe(1);
      expect(f.session.frameBytesSent).toBe(2);
      expect(f.session.firstFrameSeen).toBe(true);
      await f.session.handle({ kind: 'start', receiverProfiles: ['baseline'] });
      transport.delivered({ timestamp: 2, key: true, bytes: 2 });
      expect(f.session.framesSent).toBe(0);
      expect(f.session.firstFrameSeen).toBe(false);
    } finally { await f.session.stop(); }
  });

  it.each([280, 600])('keeps connected playback at full rate on a healthy %dms path', async rttMs => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.session.handle({ kind: 'start', receiverProfiles: ['baseline'] });
      f.transports[0].connected = true;
      await f.state('connected');
      for (let index = 0; index < 12; index += 1) {
        f.frameListeners[0]({ nals: [Buffer.from([0x65])], timestamp: index * 2 });
        await f.session.handle({ kind: 'stats', rttMs, lossRate: 0, availableBitrate: 20_000_000 });
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect(f.encoder.apply).toHaveBeenLastCalledWith(expect.objectContaining({ bitRate: 8_000_000, maxFps: 30 }));
      expect(f.signal).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }));
    } finally { await f.session.stop(); vi.useRealTimers(); }
  });

  it('falls back immediately when the viewer rejects the High video m-line', async () => {
    const f = fixture();
    try {
      await f.session.handle({ kind: 'start', receiverProfiles: ['high', 'baseline'] });
      f.transports[0].answer.mockRejectedValueOnce(new Error('Viewer rejected H.264 video'));
      await f.session.handle({ kind: 'answer', sdp: { type: 'answer', sdp: 'rejected video' } });
      expect(f.transportFactory).toHaveBeenCalledTimes(2);
      expect(f.transports[1].start).toHaveBeenCalledWith('baseline');
      expect(f.signal).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'state', state: 'connecting', fallbackReason: 'Viewer rejected H.264 video',
      }));
    } finally { await f.session.stop(); }
  });

  it('isolates delayed High answer and ICE signals from the Baseline fallback', async () => {
    const f = fixture();
    try {
      await f.session.handle({ kind: 'start', receiverProfiles: ['high', 'baseline'] });
      const highAttempt = f.session.attemptId;
      const highSignal = f.transportFactory.mock.calls[0][0].signal;
      f.transports[0].answer.mockRejectedValueOnce(new Error('Viewer rejected H.264 video'));
      await f.session.handle({ kind: 'answer', attemptId: highAttempt, sdp: { type: 'answer', sdp: 'rejected' } });
      const baselineAttempt = f.session.attemptId;
      expect(baselineAttempt).not.toBe(highAttempt);
      const before = f.signal.mock.calls.length;
      highSignal({ kind: 'ice', candidate: { candidate: 'retired' } });
      expect(f.signal.mock.calls).toHaveLength(before);
      await f.session.handle({ kind: 'answer', attemptId: highAttempt, sdp: { type: 'answer', sdp: 'late' } });
      await f.session.handle({ kind: 'ice', attemptId: highAttempt, candidate: { candidate: 'late' } });
      expect(f.transports[1].answer).not.toHaveBeenCalled();
      expect(f.transports[1].addIceCandidate).not.toHaveBeenCalled();
      await f.session.handle({ kind: 'answer', attemptId: baselineAttempt, sdp: { type: 'answer', sdp: 'current' } });
      expect(f.transports[1].answer).toHaveBeenCalledOnce();
      f.transportFactory.mock.calls[1][0].signal({ kind: 'offer', sdp: { type: 'offer', sdp: 'current' } });
      expect(f.signal).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'offer', attemptId: baselineAttempt }));
    } finally { await f.session.stop(); }
  });

  it('requires actual connected playback before reducing fallback capture work', async () => {
    const f = fixture();
    try {
      await f.session.handle({ kind: 'viewer-trace', event: 'playback-ready' });
      expect(f.session.playbackHealthy).toBe(false);
      await f.session.handle({ kind: 'start', receiverProfiles: ['baseline'] });
      f.transports[0].connected = true;
      await f.state('connected');
      expect(f.session.playbackHealthy).toBe(false);
      await f.session.handle({ kind: 'viewer-trace', event: 'playback-ready' });
      expect(f.session.playbackHealthy).toBe(true);
      await f.session.handle({ kind: 'viewer-trace', event: 'jpeg-fallback' });
      expect(f.session.playbackHealthy).toBe(false);
      await f.session.handle({ kind: 'viewer-trace', event: 'playback-ready' });
      f.session.pause();
      expect(f.session.playbackHealthy).toBe(false);
      await f.session.handle({ kind: 'viewer-trace', event: 'playback-ready' });
      expect(f.session.playbackHealthy).toBe(false);
      await f.session.resume();
      await f.session.handle({ kind: 'viewer-trace', event: 'playback-ready' });
      expect(f.session.playbackHealthy).toBe(true);
      await f.session.stop();
      expect(f.session.playbackHealthy).toBe(false);
    } finally { await f.session.stop(); }
  });

  it('reacts to fresh loss immediately, coalesces a feedback flood and expires consumed samples', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.session.handle({ kind: 'start' });
      f.transports[0].connected = true;
      await f.state('connected');
      for (let n = 0; n < 10; n++) f.session.applyStats({lossRate:0.08,rttMs:280});
      expect(f.session.policy.current().maxFps).toBe(30);
      expect(f.session.policy.current().bitRate).toBe(6_560_000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.session.policy.current().maxFps).toBe(30);
      f.session.applyStats({lossRate:0.08,rttMs:280});
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.session.policy.current().maxFps).toBe(15);
      await vi.advanceTimersByTimeAsync(6000);
      expect(f.session.policy.current().maxFps).toBe(15);
    } finally { await f.session.stop(); vi.useRealTimers(); }
  });

  it('applies fresh transport congestion to pacing and encoder without counting the same report twice', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.session.handle({ kind: 'start', receiverProfiles: ['baseline'] });
      const transport = f.transports[0]; transport.connected = true;
      await f.state('connected');
      const sample = { sequence: 1, lossRate: 0.2, rttMs: 300, availableOutgoingBitrate: 4_000_000 };
      transport.snapshot.mockResolvedValue(sample);
      transport.feedback(sample);
      expect(transport.setTuning).toHaveBeenLastCalledWith(expect.objectContaining({ bitRate: 3_600_000, maxFps: 30 }));
      await f.session.tuningChain;
      expect(f.encoder.apply).toHaveBeenLastCalledWith(expect.objectContaining({ bitRate: 3_600_000 }));
      await vi.advanceTimersByTimeAsync(2_000);
      transport.feedback(sample);
      expect(f.session.policy.current()).toMatchObject({ bitRate: 3_600_000, maxFps: 30 });
      transport.feedback({ ...sample, sequence: 2 });
      expect(f.session.policy.current().maxFps).toBe(15);
    } finally { await f.session.stop(); vi.useRealTimers(); }
  });

  it('discards a network snapshot that became stale while waiting for helper telemetry', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: (value: null) => void;
    try {
      await f.session.handle({ kind: 'start', receiverProfiles: ['baseline'] });
      const transport = f.transports[0]; transport.connected = true;
      await f.state('connected');
      f.frameListeners[0]({ nals: [Buffer.from([0x65])], timestamp: 1 });
      transport.snapshot.mockResolvedValue({ sequence: 1, lossRate: 0.4, rttMs: 300 });
      f.encoder.snapshot.mockImplementationOnce(() => new Promise<null>(resolve => { release = resolve; }));
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);
      release(null);
      await Promise.resolve(); await Promise.resolve();
      expect(f.session.policy.current()).toMatchObject({ bitRate: 8_000_000, maxFps: 30 });
    } finally { await f.session.stop(); vi.useRealTimers(); }
  });

  it('keeps healthy recovery periodic and ignores feedback from paused or replaced transports', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.session.handle({ kind: 'start', receiverProfiles: ['baseline'] });
      const old = f.transports[0]; old.connected = true;
      await f.state('connected');
      old.feedback({ sequence: 1, lossRate: 0.2, rttMs: 300 });
      const reduced = f.session.policy.current().bitRate;
      for (let sequence = 2; sequence < 100; sequence += 1) old.feedback({ sequence, lossRate: 0, rttMs: 300, availableOutgoingBitrate: 20_000_000 });
      expect(f.session.policy.current().bitRate).toBe(reduced);
      f.session.pause();
      expect(old.pause).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      old.feedback({ sequence: 101, lossRate: 0.5 });
      expect(f.session.policy.current().bitRate).toBe(reduced);
      await f.session.resume();
      expect(old.resume).toHaveBeenCalled();
      await f.session.handle({ kind: 'start', receiverProfiles: ['baseline'] });
      old.feedback({ sequence: 102, lossRate: 0.5 });
      expect(f.session.policy.current().bitRate).toBe(8_000_000);
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
    const decisions = () => f.log.mock.calls.filter(([, message]) => message === 'remote video decision');
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]).toEqual(['info', 'remote video decision', expect.objectContaining({
      trigger: 'interaction', targetFps: 30, reason: 'interaction',
    })]);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('sdp');
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('candidate');

    releaseApply();
    await f.session.tuningChain;
  });

  it('logs adaptive telemetry only when material values change', () => {
    const f = fixture();
    f.session.applyStats({ lossRate: 0, rttMs: 2, droppedFrames: 0, availableBitrate: 20_000_000 });
    f.session.applyStats({ lossRate: 0, rttMs: 2, droppedFrames: 0, availableBitrate: 20_000_000 });
    const decisions = () => f.log.mock.calls.filter(([, message]) => message === 'remote video decision');
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0]).toEqual(['info', 'remote video decision', expect.objectContaining({
      trigger: 'receiver-stats', rttMs: 2, lossRate: 0, availableBitrate: 20_000_000,
    })]);
    f.session.applyStats({ lossRate: 0.06, rttMs: 280, droppedFrames: 1, availableBitrate: 4_000_000 });
    expect(decisions()).toHaveLength(2);
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

  it('logs the connection timeline, viewer samples and stop summary through the log port', async () => {
    const log = vi.fn();
    const f = fixture({ log });
    await f.session.handle({ kind: 'start', receiverProfiles: ['high', 'baseline'] });
    expect(log).toHaveBeenCalledWith('info', 'session start requested', { receiverProfiles: ['high', 'baseline'] });
    expect(log).toHaveBeenCalledWith('info', 'webrtc attempt starting', expect.objectContaining({ profile: 'high', fallbackReason: null }));
    f.transports[0].connected = true;
    await f.state('connected');
    expect(log).toHaveBeenCalledWith('info', 'webrtc connected; encoder started', expect.objectContaining({ profile: 'high' }));
    // First viewer sample always logs; a second immediate sample is throttled.
    await f.session.handle({ kind: 'stats', lossRate: 0.01, rttMs: 40, receiveBitrate: 4_000_000 });
    await f.session.handle({ kind: 'stats', lossRate: 0.01, rttMs: 41 });
    expect(log).toHaveBeenCalledWith('info', 'viewer network sample', expect.objectContaining({ lossRate: 0.01 }));
    const samples = log.mock.calls.filter(([level, message]) => message === 'viewer network sample');
    expect(samples).toHaveLength(1);
    // Degraded samples break through the throttle at warn level.
    await f.session.handle({ kind: 'stats', lossRate: 0.2, rttMs: 40 });
    expect(log).toHaveBeenCalledWith('warn', 'viewer network sample', expect.objectContaining({ degraded: true }));
    // Viewer-reported stall/fallback events reach the log verbatim.
    await f.session.handle({ kind: 'viewer-trace', event: 'jpeg-fallback', silentForMs: 10_000 });
    expect(log).toHaveBeenCalledWith('info', 'viewer event: jpeg-fallback', expect.objectContaining({ event: 'jpeg-fallback' }));
    f.frameListeners[0]({ nals: [Buffer.from([0x65])], timestamp: 1 });
    await f.session.stop();
    expect(log).toHaveBeenCalledWith('info', 'webrtc session stopped', expect.objectContaining({ framesSent: 1 }));
  });

  it('escalates the keyframe probe streak to warn while frames are missing', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const f = fixture({ log });
    try {
      await f.session.handle({ kind: 'start', receiverProfiles: ['baseline'] });
      const transport = f.transports[0]; transport.connected = true;
      await f.state('connected');
      // One frame must flow first: a session that never reaches its first
      // frame dies via the first-frame timeout, not the probe streak.
      f.session.onFrame({ nalUnits: [Buffer.from([0x65])], timestampUs: 1 }, f.session.generation, transport);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(log).toHaveBeenCalledWith('info', 'no frames in window; requesting keyframe', expect.objectContaining({ streak: 1 }));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(log).toHaveBeenCalledWith('warn', 'no frames in window; requesting keyframe', expect.objectContaining({ streak: 2 }));
    } finally {
      await f.session.stop(); vi.useRealTimers();
    }
  });
});


it('activates only a mutually supported enhancement and restores H264 bitrate on receiver rejection', async () => {
  const f = fixture({ compound: true });
  try {
    await f.session.handle({ kind: 'start', compoundVersion: 1 });
    const transport = f.transports[0]; transport.connected = true;
    await f.state('connected');
    await vi.waitFor(() => expect(f.encoder.enableCompound).toHaveBeenCalledWith(true));
    expect(f.transportFactory).toHaveBeenLastCalledWith(expect.objectContaining({ compound: true }));
    // Reserve control bandwidth only after readiness; old receivers retain full video capacity.
    f.transportFactory.mock.calls.at(-1)![0].onCompoundMessage({ kind: 'ready', version: 1 });
    await vi.waitFor(() => expect(f.encoder.apply).toHaveBeenLastCalledWith(expect.objectContaining({ bitRate: 7_936_000 })));
    f.transportFactory.mock.calls.at(-1)![0].onCompoundMessage({ kind: 'unsupported' });
    await f.session.tuningChain;
    expect(f.encoder.apply).toHaveBeenLastCalledWith(expect.objectContaining({ bitRate: 8_000_000 }));
    expect(f.session.connected).toBe(true);
  } finally { await f.session.stop(); }
});
