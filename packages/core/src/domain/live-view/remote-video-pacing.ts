/** Byte budgets and latency limits for a remote-video sender. Time is supplied by a clock port. */
export class RemoteVideoPacingPolicy {
  readonly maxPacketBytes = 1_500;
  readonly maxQueuedBytes = 8 * 1_024 * 1_024;
  readonly maxQueuedFrames = 8;
  readonly maxQueueAgeMs = 250;
  readonly maxQueuedRepairBytes = 256 * 1_024;
  readonly maxQueuedRepairs = 256;
  private rate = 8_000_000 * 1.25;
  private credit = this.maxPacketBytes;
  private repairCredit = this.maxPacketBytes;
  private repairRate?: number;
  private updatedAt = 0;
  private needsKeyframe = true;

  constructor({ bitRate = 8_000_000, now = 0 }: { bitRate?: number; now?: number } = {}) {
    this.setBitRate(bitRate, now);
    this.reset(now);
  }

  get pacingBitRate(): number { return this.rate; }
  get waitingForKeyframe(): boolean { return this.needsKeyframe; }
  private get bytesPerMs(): number { return this.rate / 8_000; }
  private get burstBytes(): number { return Math.max(this.maxPacketBytes, this.bytesPerMs * 5); }
  // Default recovery allowance is 20%; measured protection demand may override it.
  private get repairBytesPerMs(): number { return this.repairRate === undefined ? this.bytesPerMs * .16 : this.repairRate / 8_000; }
  private get repairBurstBytes(): number { return Math.max(this.maxPacketBytes, this.repairBytesPerMs * 5); }

  setBitRate(bitRate: number, now: number): void {
    if (!Number.isFinite(bitRate) || bitRate <= 0) return;
    this.refill(now);
    this.rate = Math.max(100_000, Math.min(100_000_000, bitRate)) * 1.25;
    if (this.repairRate !== undefined) this.repairRate = Math.min(this.repairRate, this.rate / 1.25 * .35);
    this.credit = Math.min(this.credit, this.burstBytes);
    this.repairCredit = Math.min(this.repairCredit, this.repairBurstBytes);
  }

  reset(now: number): void {
    this.updatedAt = Number.isFinite(now) ? now : 0;
    this.credit = this.maxPacketBytes;
    this.repairCredit = this.maxPacketBytes;
    this.needsKeyframe = true;
  }

  setRepairBitRate(bitRate: number, now: number): void {
    if (!Number.isFinite(bitRate) || bitRate <= 0) return;
    this.refill(now);
    this.repairRate = Math.max(1_000, Math.min(this.rate / 1.25 * .35, bitRate));
    this.repairCredit = Math.min(this.repairCredit, this.repairBurstBytes);
  }

  requireKeyframe(): void { this.needsKeyframe = true; }

  acceptFrame(keyFrame: boolean): boolean {
    if (this.needsKeyframe && !keyFrame) return false;
    if (keyFrame) this.needsKeyframe = false;
    return true;
  }

  delayFor(bytes: number, now: number): number {
    if (!this.validPacket(bytes)) return Infinity;
    this.refill(now);
    return Math.max(0, (bytes - this.credit) / this.bytesPerMs);
  }

  consume(bytes: number, now: number): boolean {
    if (this.delayFor(bytes, now) > 0) return false;
    this.credit -= bytes;
    return true;
  }

  delayForRepair(bytes: number, now: number): number {
    if (!this.validPacket(bytes)) return Infinity;
    return Math.max(this.delayFor(bytes, now), (bytes - this.repairCredit) / this.repairBytesPerMs);
  }

  consumeRepair(bytes: number, now: number): boolean {
    if (this.delayForRepair(bytes, now) > 0) return false;
    this.credit -= bytes;
    this.repairCredit -= bytes;
    return true;
  }

  overloaded({ bytes, frames, ageMs }: { bytes: number; frames: number; ageMs: number }): boolean {
    return bytes > this.maxQueuedBytes || frames > this.maxQueuedFrames || ageMs >= this.maxQueueAgeMs;
  }

  frameLifetimeMs(bytes: number, keyFrame: boolean): number {
    if (!keyFrame) return this.maxQueueAgeMs;
    // A large IDR needs enough time to drain; ordinary deltas must not acquire this grace period.
    return Math.min(2_000, Math.max(this.maxQueueAgeMs, bytes / this.bytesPerMs * 1.5 + 50));
  }

  private validPacket(bytes: number): boolean {
    return Number.isFinite(bytes) && bytes > 0 && bytes <= this.maxPacketBytes;
  }

  private refill(now: number): void {
    if (!Number.isFinite(now) || now <= this.updatedAt) return;
    this.credit = Math.min(this.burstBytes, this.credit + (now - this.updatedAt) * this.bytesPerMs);
    this.repairCredit = Math.min(this.repairBurstBytes, this.repairCredit + (now - this.updatedAt) * this.repairBytesPerMs);
    this.updatedAt = now;
  }
}
