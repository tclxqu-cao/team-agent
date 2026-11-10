import type { RemoteVideoObservation } from "./remote-video-types.js";
import { REMOTE_COMPOUND_VIDEO } from "./remote-compound-video.js";

export interface CompoundBitRateAllocation { videoBitRate: number; patchBytesPerSecond: number; }

/** Demand is measured at the wire port; policy is independent of codecs and clocks. */
export class RemoteCompoundBudgetPolicy {
  private demandBits = 0;
  private demandAt = -Infinity;
  private observation: RemoteVideoObservation = {};
  private observedAt = -Infinity;

  noteDemand(bytes: number, now: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(now)) return;
    this.demandBits = Math.min(bytes, REMOTE_COMPOUND_VIDEO.maxMessageBytes) * 8 * 1000 / REMOTE_COMPOUND_VIDEO.sampleIntervalMs;
    this.demandAt = now;
  }

  observe(observation: RemoteVideoObservation, now: number): void {
    if (!Number.isFinite(now)) return;
    this.observation = observation;
    this.observedAt = now;
  }

  allocation(bitRate: number, enabled: boolean, now: number): CompoundBitRateAllocation {
    const total = Number.isFinite(bitRate) ? Math.max(0, Math.floor(bitRate)) : 0;
    if (!enabled || total < 500_000) return { videoBitRate: total, patchBytesPerSecond: 0 };
    const control = Math.min(64_000, total * 0.02);
    const age = Math.max(0, now - this.demandAt);
    const decay = age <= 750 ? 1 : Math.max(0, 1 - (age - 750) / 1500);
    let fraction = 0.2;
    if (now - this.observedAt <= 3000) {
      const { network = {}, encoder, sender } = this.observation;
      const scarce = network.applicationLimited !== true && Number.isFinite(network.availableOutgoingBitrate)
        && network.availableOutgoingBitrate! < total * 0.85;
      const severe = (network.lossRate ?? 0) >= 0.12 || (sender?.queueDelayMs ?? 0) >= 150;
      const pressure = severe || scarce || (network.lossRate ?? 0) >= 0.03
        || (sender?.queueDelayMs ?? 0) >= 60 || sender?.waitingForKeyframe === true
        || (encoder?.encodeLatencyMs ?? 0) >= 80 || (encoder?.pendingFrames ?? 0) >= 3;
      // A distant but healthy link is not congested: RTT alone never lowers this cap.
      if (pressure) fraction = severe ? 0.02 : 0.04;
    }
    const desired = control + this.demandBits * decay;
    const patchBits = Math.max(0, Math.floor(Math.min(desired, total * fraction, total - 250_000) / 1000) * 1000);
    return { videoBitRate: total - patchBits, patchBytesPerSecond: patchBits / 8 };
  }
}
