/** Qualifies transport estimates without mistaking sparse desktop traffic for a capacity limit. */
export class RemoteVideoFeedbackPolicy {
  private previous?: { at: number; bytes: number };
  observe(sample: { availableBitrate: number; sentBytes: number; targetBitRate: number;
    queueDelayMs: number; congested: boolean }, now: number): {
      availableOutgoingBitrate: number; applicationLimited: boolean; congested: boolean;
    } | null {
    if (![sample.availableBitrate, sample.sentBytes, sample.targetBitRate, sample.queueDelayMs, now].every(Number.isFinite)
      || sample.availableBitrate <= 0 || sample.availableBitrate > 1_000_000_000 || sample.sentBytes < 0 || sample.targetBitRate <= 0) return null;
    const previous = this.previous;
    if (!previous || now - previous.at > 3_000 || sample.sentBytes < previous.bytes || now < previous.at) {
      this.previous = { at: now, bytes: sample.sentBytes }; return null;
    }
    const interval = now - previous.at, bytes = sample.sentBytes - previous.bytes;
    if (interval < 100) return null;
    this.previous = { at: now, bytes: sample.sentBytes };
    if (bytes < 24_000) return null;
    const applicationLimited = bytes * 8_000 / interval < sample.targetBitRate * .6 && sample.queueDelayMs < 30;
    return { availableOutgoingBitrate: sample.availableBitrate, applicationLimited,
      congested: sample.congested === true && !applicationLimited };
  }
  reset(): void { this.previous = undefined; }
}
