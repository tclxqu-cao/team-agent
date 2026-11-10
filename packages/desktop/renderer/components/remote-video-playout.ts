import { RemoteVideoPlayoutPolicy } from '../../../core/src/domain/live-view/remote-video-playout.js';
import type { RemoteVideoReceiverStats } from '../../../core/src/domain/live-view/remote-video-types.js';

type Receiver = { track: { kind: string }; jitterBufferTarget?: number | null; playoutDelayHint?: number };

/** Writes only genuinely exposed controls and restores the receiver's previous setting. */
export class BrowserRemoteVideoPlayout {
  private policy = new RemoteVideoPlayoutPolicy();
  private applied = new Map<Receiver, { key: 'jitterBufferTarget' | 'playoutDelayHint'; original: number | null | undefined; value: number }>();
  private unsupported = new WeakSet<Receiver>();
  constructor(private readonly peer: Pick<RTCPeerConnection, 'getReceivers'>) {}
  apply(sample: RemoteVideoReceiverStats, now: number): { playoutControl: boolean; playoutTargetMs?: number } {
    if (!sample.receiver?.visible) { this.restore(); return { playoutControl: false }; }
    const target = this.policy.observe(sample.receiver, sample.jitterMs, now);
    const receiver = this.peer.getReceivers().find(receiver => receiver.track?.kind === 'video') as Receiver | undefined;
    if (!receiver || this.unsupported.has(receiver)) return { playoutControl: false };
    const key = 'jitterBufferTarget' in receiver ? 'jitterBufferTarget' : 'playoutDelayHint' in receiver ? 'playoutDelayHint' : undefined;
    if (!key) return { playoutControl: false };
    if (target !== undefined) {
      const value = key === 'jitterBufferTarget' ? target : target / 1000;
      const original = this.applied.has(receiver) ? this.applied.get(receiver)!.original : receiver[key];
      try {
        receiver[key] = value;
        if (!Number.isFinite(receiver[key]) || Math.abs(receiver[key]! - value) > .001) throw new Error('Receiver ignored playout target');
        this.applied.set(receiver, { key, original, value });
      } catch { this.unsupported.add(receiver); this.restoreReceiver(receiver); return { playoutControl: false }; }
    }
    const applied = this.applied.get(receiver);
    return applied ? { playoutControl: true, playoutTargetMs: applied.value * (applied.key === 'jitterBufferTarget' ? 1 : 1000) }
      : { playoutControl: false };
  }
  private restoreReceiver(receiver: Receiver): void {
    const setting = this.applied.get(receiver);
    if (!setting) return;
    try {
      if (receiver[setting.key] === setting.value) {
        if (setting.key === 'jitterBufferTarget') receiver.jitterBufferTarget = setting.original;
        else receiver.playoutDelayHint = setting.original as number | undefined;
      }
    } catch { /* A receiver can close before effect cleanup. */ }
    this.applied.delete(receiver);
  }
  private restore(): void { for (const receiver of this.applied.keys()) this.restoreReceiver(receiver); }
  stop(): void { this.restore(); }
}
