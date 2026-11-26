import { describe, expect, it } from 'vitest';
import { RemoteVideoReceiverPolicy } from './remote-video-receiver.js';
import { RemoteVideoPolicy } from './remote-video-policy.js';
const sample = { sequence: 1, visible: true, intervalMs: 1000, decodedFrames: 30, decodeMs: 4, droppedRatio: 0,
  width: 2560, height: 1440, viewport: { width: 390, height: 700, pixelRatio: 3, zoom: 1 } };
describe('receiver adaptation', () => {
  it('negotiates 60 fps, reduces pixels before frames under load, and restores the default for the next viewer', () => {
    const policy = new RemoteVideoPolicy('original', { dynamicResolution: true });
    policy.setMotionMode('motion-60');
    expect(policy.current().maxFps).toBe(30);
    policy.setCapabilities({ ...policy.capabilities, maxFrameRate: 60 });
    expect(policy.noteInteraction().maxFps).toBe(60);
    const observe = (sequence: number, width: number) => policy.update({ now: sequence * 6000,
      receiver: { ...sample, sequence, width, height: Math.round(width / 2), decodeMs: 45 } });
    observe(1, 2560);
    expect(observe(2, 2560)).toMatchObject({ maxFps: 60, maxEdge: 1920 });
    expect(observe(3, 1920).maxEdge).toBeLessThan(1920);
    expect(observe(4, 640).maxFps).toBe(30);
    expect(policy.resetSession().maxFps).toBe(30);
    policy.setMotionMode('motion-30');
    expect(policy.noteInteraction().maxFps).toBe(30);
  });
  it('sizes to physical viewport, preserves aspect ratio/quality ceilings and debounces zoom', () => {
    const policy = new RemoteVideoReceiverPolicy();
    policy.observe(sample, 'hd', 30, 0); expect(policy.maxEdge).toBe(1280);
    const zoom = { ...sample, viewport: { ...sample.viewport, zoom: 2 } };
    policy.observe({ ...zoom, sequence: 2 }, 'hd', 30, 1000); expect(policy.maxEdge).toBe(1280);
    policy.observe({ ...zoom, sequence: 3 }, 'hd', 30, 6000); expect(policy.maxEdge).toBe(2560);
    policy.reset(); policy.observe(zoom, 'smooth', 30, 0); expect(policy.maxEdge).toBe(1280);
    policy.reset(); policy.observe(sample, 'original', 30, 0); expect(policy.maxEdge).toBeUndefined();
  });
  it('limits receiver CPU load without treating it as network congestion and slowly restores', () => {
    const policy = new RemoteVideoPolicy('hd', { dynamicResolution: true });
    for (let n = 0; n < 8; n++) policy.update({ now: n * 1000, receiver: { ...sample, sequence: n + 1, decodeMs: 250 } });
    expect(policy.current()).toMatchObject({ bitRate: 8_000_000, maxFps: 5 });
    expect(policy.current().maxEdge).toBeLessThan(1280);
    for (let n = 8; n < 18; n++) policy.update({ now: n * 1000, receiver: { ...sample, sequence: n + 1 } });
    expect(policy.current()).toMatchObject({ bitRate: 8_000_000, maxFps: 30, maxEdge: 1280 });
  });
  it('ignores hidden/unknown/duplicate/flood and long-gap samples as pressure evidence', () => {
    const policy = new RemoteVideoReceiverPolicy();
    const pressure = { ...sample, decodeMs: 250 };
    policy.observe({ ...pressure, visible: false }, 'hd', 30, 0);
    policy.observe({ ...pressure, sequence: 2, decodedFrames: undefined }, 'hd', 30, 1000);
    policy.observe({ ...pressure, sequence: 3, intervalMs: 6000 }, 'hd', 30, 2000);
    policy.observe({ ...pressure, sequence: 3 }, 'hd', 30, 3000);
    expect(policy.maxFps).toBe(30);
    policy.observe({ ...pressure, sequence: 4 }, 'hd', 30, 3000);
    for (let sequence = 5; sequence < 30; sequence++) policy.observe({ ...pressure, sequence }, 'hd', 30, 3001);
    expect(policy.maxFps).toBe(30);
  });
  it('ignores receiver resolution caps on legacy adapters while retaining FPS control', () => {
    const policy = new RemoteVideoPolicy();
    policy.update({ now: 0, receiver: sample });
    expect(policy.current()).not.toHaveProperty('maxEdge');
  });
  it('escapes one-FPS original video with sustained delivery delay without lowering receiver FPS', () => {
    const policy = new RemoteVideoReceiverPolicy();
    const stalled = { ...sample, width: 3440, height: 1440, decodedFrames: 1, jitterBufferMs: 900 };
    policy.observe(stalled, 'original', 5, 0);
    expect(policy.maxEdge).toBeUndefined();
    policy.observe({ ...stalled, sequence: 2 }, 'original', 5, 1000);
    expect(policy.maxEdge).toBe(2560);
    expect(policy.maxFps).toBe(30);
    for (let n = 2; n <= 6; n++) policy.observe({ ...stalled, width: 2560, sequence: n + 1 }, 'original', 5, n * 1000);
    expect(policy.maxEdge).toBe(1920);
    // Healthy decoding alone cannot restore oversized frames while delivery is delayed.
    for (let n = 7; n < 12; n++) policy.observe({ ...stalled, decodedFrames: 15, sequence: n + 1 }, 'original', 15, n * 1000);
    expect(policy.maxEdge).toBe(1280);
    expect(policy.maxFps).toBe(30);
    policy.reset();
    policy.observe({ ...sample, width: 3440, jitterBufferMs: 50 }, 'original', 30, 0);
    expect(policy.maxEdge).toBeUndefined();
  });
  it('ignores missing-frame and stale delivery delays and restores after healthy playback', () => {
    const policy = new RemoteVideoReceiverPolicy();
    for (let n = 0; n < 8; n++) policy.observe({ ...sample, sequence: n + 1, decodedFrames: 0, jitterBufferMs: 900 }, 'original', 30, n * 1000);
    expect(policy.maxEdge).toBeUndefined();
    for (let n = 8; n < 10; n++) policy.observe({ ...sample, sequence: n + 1, decodedFrames: 1, jitterBufferMs: 900 }, 'original', 5, n * 1000);
    expect(policy.maxEdge).toBe(1920);
    for (let n = 10; n < 15; n++) policy.observe({ ...sample, sequence: n + 1, jitterBufferMs: 50 }, 'original', 30, n * 1000);
    expect(policy.maxEdge).toBeUndefined();
  });
  it('applies resolution relief through the video policy under the measured original-quality backlog', () => {
    const policy = new RemoteVideoPolicy('original', { dynamicResolution: true });
    for (let n = 0; n < 12; n++) {
      policy.update({ now: n * 1000, network: { rttMs: 46, lossRate: .06, availableOutgoingBitrate: 2_200_000 },
        receiver: { ...sample, sequence: n + 1, width: 3440, decodedFrames: 1, jitterBufferMs: 900 },
        sender: { queueDelayMs: 750, droppedFrames: 8, queuedBytes: 129_679, queuedFrames: 2,
          pacingBitRate: 2_450_000, waitingForKeyframe: false } });
    }
    expect(policy.current()).toMatchObject({ quality: 'original', maxEdge: 1280, maintainResolution: false });
    // Real loss still owns network backoff; resolution adaptation does not bypass it.
    expect(policy.current().maxFps).toBe(5);
    expect(policy.current().bitRate).toBe(2_000_000);
  });
  it('restores clarity when buffering is within the browser-required minimum', () => {
    const policy = new RemoteVideoReceiverPolicy();
    for (let n = 0; n < 2; n++) policy.observe({ ...sample, sequence: n + 1, width: 3440,
      decodedFrames: 1, jitterBufferMs: 900, jitterBufferMinimumMs: 0 }, 'original', 5, n * 1000);
    expect(policy.maxEdge).toBe(2560);
    for (let n = 2; n < 8; n++) policy.observe({ ...sample, sequence: n + 1, width: 2560,
      jitterBufferMs: 300, jitterBufferMinimumMs: 350 }, 'original', 30, n * 1000);
    expect(policy.maxEdge).toBeUndefined();
    expect(policy.maxFps).toBe(30);
  });
  it('recovers low cadence when presentation lateness fits its frame interval', () => {
    const policy = new RemoteVideoReceiverPolicy();
    for (let n = 0; n < 3; n++) policy.observe({ ...sample, sequence: n + 1, presentationDelayMs: 500 }, 'original', 30, n * 1000);
    expect(policy.maxFps).toBe(5);
    // Measured 5 FPS playback: 4 ms decoding, no dropped frames, 100 ms lateness.
    // A fixed 50 ms threshold repeatedly demoted this already-low cadence.
    for (let n = 3; n < 8; n++) policy.observe({ ...sample, sequence: n + 1, decodedFrames: 5,
      presentationDelayMs: 100, jitterBufferMs: 36 }, 'original', 5, n * 1000);
    expect(policy.maxFps).toBe(15);
    for (let n = 8; n < 13; n++) policy.observe({ ...sample, sequence: n + 1,
      presentationDelayMs: 30, jitterBufferMs: 36 }, 'original', 15, n * 1000);
    expect(policy.maxFps).toBe(30);
    for (let n = 13; n < 16; n++) policy.observe({ ...sample, sequence: n + 1,
      presentationDelayMs: 100 }, 'original', 30, n * 1000);
    expect(policy.maxFps).toBe(5);
  });
});
