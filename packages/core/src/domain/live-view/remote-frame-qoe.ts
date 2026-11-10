interface FrameRecord { sentAt: number; capturedAt?: number; }
export class RemoteFrameQoe {
  private frames = new Map<number, FrameRecord>();
  private receipts = new Set<number>();
  private clock?: { offsetMs: number; uncertaintyMs: number; at: number };
  private samples: { feedbackMs: number; captureToPresentationMs?: number }[] = [];
  sent(rtp: number, sentAt: number, capturedAt?: number): void {
    if (this.frames.has(rtp) || this.receipts.has(rtp)) return;
    this.frames.set(rtp, { sentAt, capturedAt });
    while (this.frames.size > 256) this.frames.delete(this.frames.keys().next().value!);
  }
  synchronize(t0: number, t1: number, t2: number, t3: number): boolean {
    if (![t0, t1, t2, t3].every(Number.isFinite) || t3 < t0 || t2 < t1) return false;
    const roundTrip = t3 - t0 - (t2 - t1);
    if (roundTrip < 0 || roundTrip > 5000) return false;
    if (!this.clock || t3 - this.clock.at > 30_000 || roundTrip / 2 <= this.clock.uncertaintyMs) {
      this.clock = { offsetMs: (t1 - t0 + t2 - t3) / 2, uncertaintyMs: roundTrip / 2, at: t3 };
    }
    return true;
  }
  presented(rtp: number, presentedAt: number, receivedAt: number): boolean {
    const frame = this.frames.get(rtp);
    if (!frame || !Number.isFinite(presentedAt) || receivedAt < frame.sentAt) return false;
    this.frames.delete(rtp);
    this.receipts.add(rtp);
    while (this.receipts.size > 256) this.receipts.delete(this.receipts.values().next().value!);
    const sample: { feedbackMs: number; captureToPresentationMs?: number } = { feedbackMs: receivedAt - frame.sentAt };
    if (this.clock && receivedAt - this.clock.at <= 30_000 && Number.isFinite(frame.capturedAt)) {
      const latency = presentedAt - this.clock.offsetMs - frame.capturedAt!;
      if (latency >= -this.clock.uncertaintyMs && latency <= 60_000) sample.captureToPresentationMs = Math.max(0, latency);
    }
    this.samples.push(sample); if (this.samples.length > 120) this.samples.shift();
    return true;
  }
  snapshot() {
    const percentile = (values: number[]) => values.length ? values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : undefined;
    return { presentedFrames: this.samples.length, feedbackP95Ms: percentile(this.samples.map(sample => sample.feedbackMs)),
      captureToPresentationP95Ms: percentile(this.samples.flatMap(sample => sample.captureToPresentationMs === undefined ? [] : [sample.captureToPresentationMs])),
      clockUncertaintyMs: this.clock?.uncertaintyMs };
  }
}
