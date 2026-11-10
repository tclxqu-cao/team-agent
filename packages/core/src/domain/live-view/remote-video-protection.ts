import type { RemoteVideoNetworkTelemetry, RemoteVideoSenderTelemetry } from './remote-video-types.js';

/** Allocates actual recovery cost before the nominal media budget is split into video and patches. */
export class RemoteVideoProtectionPolicy {
  private previous?: { at: number; sent: number; repaired: number };
  private repairFraction = .2;
  private reservedBitRate = 0;

  seed(sender: Pick<RemoteVideoSenderTelemetry, 'sentBytes' | 'repairedBytes'>, now: number): void {
    if (Number.isFinite(now) && Number.isFinite(sender.sentBytes) && Number.isFinite(sender.repairedBytes)
      && sender.sentBytes! >= 0 && sender.repairedBytes! >= 0) {
      this.previous = { at: now, sent: sender.sentBytes!, repaired: sender.repairedBytes! };
    }
  }

  observe(sender: Partial<RemoteVideoSenderTelemetry> | undefined, network: RemoteVideoNetworkTelemetry, now: number): void {
    const sent = sender?.sentBytes, repaired = sender?.repairedBytes;
    if (!Number.isFinite(now) || !Number.isFinite(sent) || !Number.isFinite(repaired) || sent! < 0 || repaired! < 0) return;
    const previous = this.previous;
    if (!previous || now <= previous.at || now - previous.at > 5_000 || sent! < previous.sent || repaired! < previous.repaired) {
      this.previous = { at: now, sent: sent!, repaired: repaired! }; return;
    }
    const interval = now - previous.at;
    if (interval < 250) return;
    this.previous = { at: now, sent: sent!, repaired: repaired! };
    const repairRate = (repaired! - previous.repaired) * 8_000 / interval;
    const totalRate = ((sent! - previous.sent) + (repaired! - previous.repaired)) * 8_000 / interval;
    // No traffic is not evidence that a path has healed.
    if (totalRate <= 0) return;
    const desiredReserve = repairRate * 1.2;
    this.reservedBitRate = desiredReserve > this.reservedBitRate ? desiredReserve
      : this.reservedBitRate * .5 + desiredReserve * .5;
    const share = totalRate > 0 ? repairRate / totalRate : 0;
    const queued = (sender?.queuedRepairBytes ?? 0) > 0;
    const demand = Math.max(.02, Math.min(.3, share * 1.5 + (queued ? .05 : .02),
      (network.lossRate ?? 0) >= .12 ? .3 : .25));
    this.repairFraction = demand > this.repairFraction ? demand : Math.max(demand, this.repairFraction - .02);
  }

  allocation(totalBitRate: number): { videoBitRate: number; reservedBitRate: number; repairBitRate: number } {
    const total = Number.isFinite(totalBitRate) ? Math.max(0, Math.floor(totalBitRate)) : 0;
    const reservedBitRate = Math.min(Math.floor(total * .25), Math.floor(this.reservedBitRate / 1_000) * 1_000);
    return { videoBitRate: total - reservedBitRate, reservedBitRate,
      repairBitRate: Math.floor(total * Math.max(this.repairFraction, total > 0 ? reservedBitRate / total : 0)) };
  }
  reset(): void { this.previous = undefined; this.repairFraction = .2; this.reservedBitRate = 0; }
}
