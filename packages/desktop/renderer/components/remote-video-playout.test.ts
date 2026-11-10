import { describe, expect, it } from 'vitest';
import { BrowserRemoteVideoPlayout } from './remote-video-playout.js';

const sample = (sequence: number) => ({ jitterMs: 5, receiver: { sequence, visible: true, intervalMs: 1000,
  decodedFrames: 30, jitterBufferMs: 80, decodeMs: 5, droppedRatio: 0 } });

describe('browser playout control', () => {
  it('writes exposed millisecond controls and restores null after repeated targets and hidden state', () => {
    const receiver = { track: { kind: 'video' }, jitterBufferTarget: null as number | null };
    const adapter = new BrowserRemoteVideoPlayout({ getReceivers: () => [receiver as any] });
    expect(adapter.apply(sample(1), 1000)).toEqual({ playoutControl: true, playoutTargetMs: 40 });
    expect(receiver.jitterBufferTarget).toBe(40);
    adapter.apply(sample(2), 2000); adapter.apply(sample(3), 3000);
    adapter.stop(); expect(receiver.jitterBufferTarget).toBeNull();
    adapter.apply(sample(4), 4000);
    adapter.apply({ receiver: { sequence: 5, visible: false } }, 5000);
    expect(receiver.jitterBufferTarget).toBeNull();
  });
  it('supports the legacy seconds property and leaves unsupported or rejected controls alone', () => {
    const legacy = { track: { kind: 'video' }, playoutDelayHint: .2 };
    const adapter = new BrowserRemoteVideoPlayout({ getReceivers: () => [legacy as any] });
    expect(adapter.apply(sample(1), 1000).playoutTargetMs).toBe(40);
    expect(legacy.playoutDelayHint).toBe(.04); adapter.stop(); expect(legacy.playoutDelayHint).toBe(.2);
    const unsupported = { track: { kind: 'video' } };
    expect(new BrowserRemoteVideoPlayout({ getReceivers: () => [unsupported as any] }).apply(sample(1), 1000).playoutControl).toBe(false);
    expect(unsupported).not.toHaveProperty('jitterBufferTarget');
    const rejected = { track: { kind: 'video' }, get jitterBufferTarget() { return null; }, set jitterBufferTarget(_value) { throw new Error('unsupported'); } };
    expect(new BrowserRemoteVideoPlayout({ getReceivers: () => [rejected as any] }).apply(sample(1), 1000).playoutControl).toBe(false);
  });
  it('does not overwrite a setting changed by another owner during cleanup', () => {
    const receiver = { track: { kind: 'video' }, jitterBufferTarget: 100 };
    const adapter = new BrowserRemoteVideoPlayout({ getReceivers: () => [receiver as any] });
    adapter.apply(sample(1), 1000); receiver.jitterBufferTarget = 120; adapter.stop();
    expect(receiver.jitterBufferTarget).toBe(120);
  });
});
