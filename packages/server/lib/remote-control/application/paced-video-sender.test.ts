import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteVideoPacingPolicy } from '../../../../core/src/domain/live-view/remote-video-pacing.js';
// @ts-expect-error gateway ESM
import { PacedVideoSender } from './paced-video-sender.mjs';

function frame(id: string, count = 8, keyFrame = true) {
  return { keyFrame, packets: Array.from({ length: count }, (_, index) => ({ value: { id, index }, bytes: 1_250 })) };
}

function fixture(bitRate = 800_000) {
  const writes: Array<{ id: string; index: number; at: number }> = [];
  const write = vi.fn(async (packet: { id: string; index: number }) => { writes.push({ ...packet, at: Date.now() }); });
  const onKeyframe = vi.fn();
  const onError = vi.fn();
  const onFrameSent = vi.fn();
  const policy = new RemoteVideoPacingPolicy({ bitRate, now: Date.now() });
  const clock = { now: () => Date.now(), schedule: (fn: () => void, ms: number) => setTimeout(fn, ms), cancel: clearTimeout };
  const sender = new PacedVideoSender({ policy, clock, write, onKeyframe, onError, onFrameSent });
  return { sender, writes, write, policy, clock, onKeyframe, onError, onFrameSent };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('PacedVideoSender', () => {
  it('bounds the repair queue and cancels it across fresh keyframes, pause and stale deadlines', async () => {
    vi.useFakeTimers();
    const writes = vi.fn(async () => undefined), expired = vi.fn();
    const policy = new RemoteVideoPacingPolicy({ bitRate: 100_000 });
    const sender = new PacedVideoSender({ policy, clock: { now: () => Date.now(), schedule: setTimeout, cancel: clearTimeout },
      write: writes, writeRepair: writes, onRepairExpired: expired, onKeyframe: vi.fn(), onError: vi.fn() });
    const enqueue = (value: number, expiresAt = Date.now() + 100) => sender.enqueueRepair({ value, bytes: 1_250, expiresAt });
    for (let index = 0; index < 209; index++) expect(enqueue(index)).toBe(true);
    expect(enqueue(210)).toBe(false);
    expect(sender.snapshot().queuedRepairBytes).toBeLessThanOrEqual(policy.maxQueuedRepairBytes);
    sender.enqueue(frame('new-idr', 1));
    expect(sender.snapshot().queuedRepairs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    enqueue(999, Date.now() + 1);
    await vi.advanceTimersByTimeAsync(2);
    expect(expired).toHaveBeenCalledWith(999);
    expect(writes.mock.calls.some(([value]) => value === 999)).toBe(false);
    enqueue(1_000); sender.pause(); sender.resume();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes.mock.calls.some(([value]) => value === 1_000)).toBe(false);
    expect(sender.snapshot().queuedRepairs).toBe(0);
    sender.stop();
  });
  it('reports intentional keyframe replacement separately from overload drops', () => {
    vi.useFakeTimers(); const f = fixture();
    f.sender.enqueue(frame('old-key', 1));
    f.sender.enqueue(frame('old-delta', 1, false));
    f.sender.enqueue(frame('new-key', 1));
    expect(f.sender.snapshot()).toMatchObject({ droppedFrames: 0, supersededFrames: 2 });
    expect(f.sender.snapshot()).toMatchObject({ droppedFrames: 0, supersededFrames: 0 }); f.sender.stop();
  });
  it('spreads a complete frame over time without changing packet order', async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(f.sender.enqueue({ ...frame('key'), context: { frame: 1 } })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.writes).toHaveLength(1);
    expect(f.onFrameSent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(80);
    expect(f.writes.map(packet => packet.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(f.writes.at(-1)!.at - f.writes[0].at).toBeGreaterThanOrEqual(60);
    expect(f.sender.snapshot()).toMatchObject({ queuedBytes: 0, queuedFrames: 0 });
    expect(f.onFrameSent).toHaveBeenCalledTimes(1);
    expect(f.onFrameSent).toHaveBeenCalledWith({ frame: 1 });
  });

  it('drops dependent backlog on overflow and resumes only from a fresh keyframe', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.sender.enqueue(frame('old-key'));
    for (let index = 0; index < 20; index += 1) f.sender.enqueue(frame(`old-delta-${index}`, 1, false));
    expect(f.onKeyframe).toHaveBeenCalledTimes(1);
    expect(f.sender.snapshot()).toMatchObject({ queuedBytes: 0, waitingForKeyframe: true });
    expect(f.sender.enqueue(frame('dependent', 1, false))).toBe(false);
    expect(f.sender.enqueue(frame('fresh-key', 1))).toBe(true);
    expect(f.sender.enqueue(frame('fresh-delta', 1, false))).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.writes.map(packet => packet.id)).toEqual(['fresh-key', 'fresh-delta']);
    expect(f.onError).not.toHaveBeenCalled();
  });

  it('lets a partially sent large keyframe finish when dependent backlog overflows', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.sender.enqueue(frame('large-key', 100));
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 12; index += 1) f.sender.enqueue(frame(`delta-${index}`, 1, false));
    expect(f.sender.snapshot().waitingForKeyframe).toBe(true);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(f.writes).toHaveLength(100);
    expect(new Set(f.writes.map(packet => packet.id))).toEqual(new Set(['large-key']));
    expect(f.sender.enqueue(frame('still-dependent', 1, false))).toBe(false);
    f.sender.enqueue(frame('recovery-key', 1));
    await vi.advanceTimersByTimeAsync(10);
    expect(f.writes.at(-1)?.id).toBe('recovery-key');
  });

  it('bounds keyframe lifetime and reports discarded frames once per telemetry sample', async () => {
    vi.useFakeTimers();
    const f = fixture(100_000);
    f.sender.enqueue(frame('too-slow', 100));
    await vi.advanceTimersByTimeAsync(2_200);
    expect(f.writes.length).toBeGreaterThan(1);
    expect(f.writes.length).toBeLessThan(100);
    expect(f.onKeyframe).toHaveBeenCalledTimes(1);
    expect(f.onFrameSent).not.toHaveBeenCalled();
    expect(f.sender.snapshot()).toMatchObject({ queuedBytes: 0, droppedFrames: 1, waitingForKeyframe: true });
    expect(f.sender.snapshot().droppedFrames).toBe(0);
  });

  it('does not stack writes or revive old packets after a blocked write and pause/resume', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: () => void;
    f.write.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    f.sender.enqueue(frame('old'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.write).toHaveBeenCalledTimes(1);
    f.sender.pause();
    expect(f.sender.enqueue(frame('paused'))).toBe(false);
    f.sender.resume();
    expect(f.sender.enqueue(frame('delta-without-key', 1, false))).toBe(false);
    f.sender.enqueue(frame('new', 2));
    await vi.advanceTimersByTimeAsync(30);
    expect(f.write).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(30);
    expect(f.write.mock.calls.map(([packet]) => packet.id)).toEqual(['old', 'new', 'new']);
    expect(f.sender.snapshot().queuedBytes).toBe(0);
  });

  it('contains writer failures and cancels pending work on stop', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const error = new Error('socket closed');
    f.write.mockRejectedValueOnce(error);
    f.sender.enqueue(frame('failed'));
    await vi.advanceTimersByTimeAsync(100);
    expect(f.onError).toHaveBeenCalledWith(error);
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.sender.snapshot().queuedBytes).toBe(0);
    expect(f.sender.enqueue(frame('after-stop'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps memory bounded and rejects malformed packet costs', () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(f.sender.enqueue({ keyFrame: true, packets: [{ value: {}, bytes: NaN }] })).toBe(false);
    expect(f.sender.enqueue({ keyFrame: true, packets: [{ value: {}, bytes: -1 }] })).toBe(false);
    expect(f.sender.enqueue(frame('oversized', 7_000))).toBe(false);
    expect(f.sender.snapshot()).toMatchObject({ queuedBytes: 0, waitingForKeyframe: true });
    expect(f.onKeyframe).toHaveBeenCalledTimes(1);
  });

  it('reschedules a pending byte deficit immediately when tuning lowers the rate', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.sender.enqueue(frame('key', 3));
    await vi.advanceTimersByTimeAsync(0);
    f.sender.setBitRate(400_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.writes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30);
    expect(f.writes).toHaveLength(3);
  });

  it('ignores a cancelled timer callback from an older generation', async () => {
    vi.useFakeTimers();
    const callbacks: Array<() => void> = [];
    const write = vi.fn(async () => undefined);
    const sender = new PacedVideoSender({
      policy: new RemoteVideoPacingPolicy(), write, onKeyframe: vi.fn(), onError: vi.fn(),
      clock: { now: () => 0, schedule: (callback: () => void) => { callbacks.push(callback); return callback; }, cancel: vi.fn() },
    });
    sender.enqueue(frame('old', 1));
    sender.pause(); sender.resume();
    sender.enqueue(frame('fresh', 1));
    callbacks[0]();
    expect(write).not.toHaveBeenCalled();
    callbacks[1]();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ id: 'fresh', index: 0 }, expect.objectContaining({ keyFrameStart: true }));
  });

  it('drains an original-quality keyframe larger than 2MB without expiring it at the delta deadline', async () => {
    vi.useFakeTimers();
    const f = fixture(20_000_000);
    expect(f.sender.enqueue(frame('large-original', 2_000))).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.writes).toHaveLength(2_000);
    expect(f.onFrameSent).toHaveBeenCalledTimes(1);
    expect(f.onKeyframe).not.toHaveBeenCalled();
    expect(f.sender.snapshot()).toMatchObject({ queuedBytes: 0, droppedFrames: 0 });
  });
});
