import { describe, expect, it } from 'vitest';
import { RemoteVideoRecoveryHistory } from './remote-video-recovery.js';

function packet(sequence: number, keyFrameStart = sequence === 0, frameDeadline = 1_000, bytes = 1_276) {
  return { sequence, keyFrameStart, frameDeadline, bytes, value: `packet-${sequence}` };
}

describe('RemoteVideoRecoveryHistory', () => {
  it('covers an entire large keyframe beyond the old 128-packet history', () => {
    const history = new RemoteVideoRecoveryHistory<string>();
    for (let sequence = 0; sequence < 2_000; sequence++) history.record(packet(sequence), sequence / 4);
    expect(history.snapshot(500)).toMatchObject({ historyPackets: 2_000, historyBytes: 2_552_000 });
    expect(history.request(0, 500)).toMatchObject({ action: 'repair', entry: { value: 'packet-0' } });
    expect(history.request(1_999, 500)).toMatchObject({ action: 'repair' });
  });

  it('deduplicates reservations, spaces retries by RTT and eventually requests a keyframe', () => {
    const history = new RemoteVideoRecoveryHistory<string>();
    history.setRtt(100);
    history.record(packet(0), 0);
    for (let attempt = 0; attempt < 3; attempt++) {
      const request = history.request(0, attempt * 100);
      expect(request.action).toBe('repair');
      if (request.action !== 'repair') throw new Error('missing repair');
      expect(history.request(0, attempt * 100)).toEqual({ action: 'ignore' });
      expect(history.beginRepair(request.entry, attempt * 100)).toBe('send');
      expect(history.request(0, attempt * 100 + 99)).toEqual({ action: 'ignore' });
    }
    expect(history.request(0, 300)).toEqual({ action: 'recover' });
    expect(history.request(0, 500)).toEqual({ action: 'ignore' });
    expect(history.snapshot(500)).toMatchObject({ historyPackets: 0, awaitingRecoveryKeyframe: true });
  });

  it('checks deadlines again after a repair waits for its send budget', () => {
    const history = new RemoteVideoRecoveryHistory<string>();
    history.setRtt(50);
    history.record(packet(0, true, 250), 0);
    const request = history.request(0, 399);
    if (request.action !== 'repair') throw new Error('missing repair');
    // Telemetry may prune the entry before the queued send reaches its deadline callback.
    expect(history.snapshot(400).historyPackets).toBe(0);
    expect(history.beginRepair(request.entry, 400)).toBe('recover');
    expect(history.snapshot(400).historyBytes).toBe(0);
  });

  it('retires older IDR references and ignores old or future NACKs across sequence wraparound', () => {
    const history = new RemoteVideoRecoveryHistory<string>();
    history.record(packet(65_534, true), 0);
    const old = history.request(65_534, 0);
    history.record(packet(65_535, false), 1);
    history.record(packet(0, false), 2);
    expect(history.request(65_535, 2).action).toBe('repair');
    expect(history.request(1, 2).action).toBe('ignore');
    expect(history.request(65_533, 2).action).toBe('ignore');
    history.record(packet(1, true), 3);
    if (old.action !== 'repair') throw new Error('missing repair');
    expect(history.beginRepair(old.entry, 3)).toBe('ignore');
    expect(history.request(0, 3).action).toBe('ignore');
    expect(history.request(1, 3).action).toBe('repair');
  });

  it('bounds history bytes, packet count and age and recovers when a needed packet was evicted', () => {
    const history = new RemoteVideoRecoveryHistory<string>();
    for (let index = 0; index < 9_000; index++) history.record(packet(index, index === 0, 5_000), 0);
    const snapshot = history.snapshot(0);
    expect(snapshot.historyBytes).toBeLessThanOrEqual(history.maxBytes);
    expect(snapshot.historyPackets).toBeLessThanOrEqual(history.maxPackets);
    expect(history.request(0, 1).action).toBe('recover');
    history.record(packet(9_000, true, 5_000), 10);
    expect(history.snapshot(2_010).historyBytes).toBe(0);
    expect(history.request(9_000, 2_010).action).toBe('recover');
    const small = new RemoteVideoRecoveryHistory<string>();
    for (let index = 0; index < 9_000; index++) small.record(packet(index, index === 0, 5_000, 1), 0);
    expect(small.snapshot(0).historyPackets).toBe(small.maxPackets);
  });

  it('uses valid RTT to adjust the next frame recovery window without extending stale entries', () => {
    const fast = new RemoteVideoRecoveryHistory<string>();
    const slow = new RemoteVideoRecoveryHistory<string>();
    fast.setRtt(50); slow.setRtt(400); slow.setRtt(NaN); slow.setRtt(-1);
    fast.record(packet(0, true, 250), 0); slow.record(packet(0, true, 250), 0);
    expect(fast.request(0, 500).action).toBe('recover');
    expect(slow.request(0, 500).action).toBe('repair');
  });

  it('requires a keyframe after reset and rejects malformed sequence or time inputs', () => {
    const history = new RemoteVideoRecoveryHistory<string>();
    history.record(packet(0, false), 0);
    history.record(packet(-1, true), 0);
    history.record(packet(0, true, NaN), 0);
    history.record(packet(0), NaN);
    expect(history.snapshot(0).historyPackets).toBe(0);
    history.record(packet(0), 0); history.reset();
    history.record(packet(1, false), 1);
    expect(history.request(1, 2).action).toBe('ignore');
  });
});
