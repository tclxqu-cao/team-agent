import type { RemoteVideoReceiverTelemetry } from './remote-video-types.js';

/** A bounded target, independent of whether a browser exposes a writable playout control. */
export class RemoteVideoPlayoutPolicy {
  private targetMs = 40;
  private sequence = -1;
  private observedAt = -Infinity;
  private healthy = 0;
  observe(sample: RemoteVideoReceiverTelemetry | undefined, jitterMs: number | undefined, now: number): number | undefined {
    if (!sample || !sample.visible || !Number.isSafeInteger(sample.sequence) || sample.sequence <= this.sequence
      || !Number.isFinite(now) || (sample.intervalMs ?? 0) < 250 || (sample.intervalMs ?? Infinity) > 5_000
      || (sample.decodedFrames ?? 0) < 3 || !Number.isFinite(sample.jitterBufferMs)) return undefined;
    this.sequence = sample.sequence;
    if (now - this.observedAt < 750) return undefined;
    this.observedAt = now;
    // The browser already enforces its intrinsic minimum. Feeding its measured
    // minimum back into our requested target can latch an earlier high delay.
    const networkTarget = Math.max(20, Math.min(150, (Number.isFinite(jitterMs) ? Math.max(0, jitterMs!) * 2 : 10) + 20));
    if (networkTarget > this.targetMs) {
      this.targetMs = Math.min(150, Math.max(networkTarget, this.targetMs + 10)); this.healthy = 0;
    } else if ((sample.decodeMs ?? 0) < 25 && (sample.droppedRatio ?? 0) < .02) {
      if (++this.healthy >= 3) { this.targetMs = Math.max(networkTarget, this.targetMs - 10); this.healthy = 0; }
    } else this.healthy = 0;
    return Math.round(this.targetMs);
  }
}
