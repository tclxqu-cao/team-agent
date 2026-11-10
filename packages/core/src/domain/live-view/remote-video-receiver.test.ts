import { describe, expect, it } from 'vitest';
import { RemoteVideoReceiverPolicy } from './remote-video-receiver.js';
import { RemoteVideoPolicy } from './remote-video-policy.js';
const sample = { sequence: 1, visible: true, intervalMs: 1000, decodedFrames: 30, decodeMs: 4, droppedRatio: 0,
  width: 2560, height: 1440, viewport: { width: 390, height: 700, pixelRatio: 3, zoom: 1 } };
describe('receiver adaptation', () => {
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
});
