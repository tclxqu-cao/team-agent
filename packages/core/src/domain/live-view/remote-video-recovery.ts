/** Opaque packet values keep RTP, sockets and clocks outside the domain. */
export interface RemoteVideoRepair<T> {
  readonly sequence: number;
  readonly bytes: number;
  readonly expiresAt: number;
  readonly value: T;
  readonly generation: number;
}

interface HistoryEntry<T> extends RemoteVideoRepair<T> {
  pending: boolean;
  attempts: number;
  lastRepairAt: number;
}

export type RemoteVideoRepairRequest<T> =
  | { action: 'repair'; entry: RemoteVideoRepair<T> }
  | { action: 'ignore' | 'recover' };

/** Bounded recovery within the latest independently decodable video generation. */
export class RemoteVideoRecoveryHistory<T> {
  readonly maxBytes = 8 * 1_024 * 1_024;
  readonly maxPackets = 8_192;
  readonly maxAgeMs = 2_000;
  readonly maxAttempts = 3;
  private entries = new Map<number, HistoryEntry<T>>();
  private bytes = 0;
  private rttMs = 150;
  private latestSequence: number | undefined;
  private sequenceSpan = 0;
  private needsKeyframe = true;
  private nextPruneAt = -Infinity;
  private generation = 0;

  setRtt(rttMs: number): void {
    if (Number.isFinite(rttMs) && rttMs > 0 && rttMs <= 10_000) this.rttMs = rttMs;
  }

  record(packet: {
    sequence: number; bytes: number; value: T; frameDeadline: number; keyFrameStart: boolean;
  }, now: number): void {
    if (!this.validSequence(packet.sequence) || !Number.isFinite(now)
      || !Number.isSafeInteger(packet.bytes) || packet.bytes <= 0 || packet.bytes > this.maxBytes
      || !Number.isFinite(packet.frameDeadline)) return;
    if (packet.keyFrameStart) this.reset(false);
    if (this.needsKeyframe) return;
    if (now >= this.nextPruneAt) this.prune(now);
    const repairWindow = Math.max(150, Math.min(1_000, 2 * this.rttMs + 50));
    const expiresAt = Math.min(now + this.maxAgeMs, packet.frameDeadline + repairWindow);
    if (expiresAt <= now) return;
    this.remove(packet.sequence);
    this.entries.set(packet.sequence, { ...packet, expiresAt, generation: this.generation,
      pending: false, attempts: 0, lastRepairAt: -Infinity });
    this.bytes += packet.bytes;
    this.latestSequence = packet.sequence;
    this.sequenceSpan = Math.min(32_767, this.sequenceSpan + 1);
    while (this.bytes > this.maxBytes || this.entries.size > this.maxPackets) {
      this.remove(this.entries.keys().next().value!);
    }
  }

  request(sequence: number, now: number): RemoteVideoRepairRequest<T> {
    if (!this.validSequence(sequence) || !Number.isFinite(now) || this.needsKeyframe
      || this.latestSequence === undefined
      || ((this.latestSequence - sequence + 65_536) & 65_535) >= this.sequenceSpan) return { action: 'ignore' };
    const entry = this.entries.get(sequence);
    if (!entry || now >= entry.expiresAt) {
      this.reset();
      return { action: 'recover' };
    }
    if (entry.pending || now - entry.lastRepairAt < Math.max(30, Math.min(1_000, this.rttMs))) return { action: 'ignore' };
    if (entry.attempts >= this.maxAttempts) {
      this.reset();
      return { action: 'recover' };
    }
    entry.pending = true;
    return { action: 'repair', entry };
  }

  beginRepair(packet: RemoteVideoRepair<T>, now: number): 'send' | 'ignore' | 'recover' {
    const entry = this.entries.get(packet.sequence);
    // IDRs and reset retire outstanding references. Pruning an expired packet must still
    // permit its queued repair to trigger recovery rather than silently losing the deadline.
    if (packet.generation !== this.generation || this.needsKeyframe) return 'ignore';
    if (now >= packet.expiresAt || !entry) {
      this.reset();
      return 'recover';
    }
    if (entry !== packet || !entry.pending) return 'ignore';
    entry.pending = false;
    entry.attempts += 1;
    entry.lastRepairAt = now;
    return 'send';
  }

  reset(needsKeyframe = true): void {
    this.generation += 1;
    this.entries.clear();
    this.bytes = 0;
    this.latestSequence = undefined;
    this.sequenceSpan = 0;
    this.needsKeyframe = needsKeyframe;
    this.nextPruneAt = -Infinity;
  }

  snapshot(now: number): { historyBytes: number; historyPackets: number; awaitingRecoveryKeyframe: boolean } {
    this.prune(now);
    return { historyBytes: this.bytes, historyPackets: this.entries.size, awaitingRecoveryKeyframe: this.needsKeyframe };
  }

  private prune(now: number): void {
    for (const [sequence, entry] of this.entries) if (now >= entry.expiresAt) this.remove(sequence);
    // Avoid scanning the history for every fragment of a large IDR.
    this.nextPruneAt = now + 50;
  }

  private remove(sequence: number): void {
    const entry = this.entries.get(sequence);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(sequence);
  }

  private validSequence(sequence: number): boolean {
    return Number.isInteger(sequence) && sequence >= 0 && sequence <= 65_535;
  }
}
