import type {
  RemoteVideoAdapterCapabilities,
  RemoteVideoDecision,
  RemoteVideoH264Profile,
  RemoteVideoObservation,
  RemoteVideoQuality,
} from "./remote-video-types.js";

export const REMOTE_VIDEO_PROFILES = Object.freeze({
  smooth: Object.freeze({ minBitRate: 500_000, maxBitRate: 2_000_000 }),
  hd: Object.freeze({ minBitRate: 1_000_000, maxBitRate: 8_000_000 }),
  original: Object.freeze({ minBitRate: 2_000_000, maxBitRate: 20_000_000 }),
} satisfies Record<RemoteVideoQuality, { minBitRate: number; maxBitRate: number }>);

const DEFAULT_CAPABILITIES: RemoteVideoAdapterCapabilities = {
  dynamicBitrate: true,
  dynamicFrameRate: true,
  encoderQueueTelemetry: false,
  explicitH264Profile: false,
  codecPreferences: ["baseline"],
};

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lowerFps(value: number): number {
  if (value > 15) return 15;
  return 5;
}

function raiseFps(value: number): number {
  if (value < 15) return 15;
  return 30;
}

export class RemoteVideoPolicy {
  readonly capabilities: RemoteVideoAdapterCapabilities;
  private quality: RemoteVideoQuality;
  private bitRate: number;
  private activityFps = 30;
  private pressureFps = 30;
  private idleSince: number | null = null;
  private motionSamples = 0;
  private healthySamples = 0;
  private congestedSamples = 0;
  private preferredCodec: RemoteVideoH264Profile;
  private highFallbackUsed = false;

  constructor(
    quality: RemoteVideoQuality = "hd",
    capabilities: Partial<RemoteVideoAdapterCapabilities> = {},
  ) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...capabilities };
    this.quality = REMOTE_VIDEO_PROFILES[quality] ? quality : "hd";
    this.bitRate = REMOTE_VIDEO_PROFILES[this.quality].maxBitRate;
    this.preferredCodec = this.capabilities.codecPreferences.includes("high") ? "high" : "baseline";
  }

  setQuality(quality: RemoteVideoQuality): RemoteVideoDecision {
    this.quality = REMOTE_VIDEO_PROFILES[quality] ? quality : "hd";
    this.bitRate = REMOTE_VIDEO_PROFILES[this.quality].maxBitRate;
    this.healthySamples = 0;
    this.congestedSamples = 0;
    return this.current("quality");
  }

  resetSession(): RemoteVideoDecision {
    this.activityFps = 30;
    this.pressureFps = 30;
    this.idleSince = null;
    this.motionSamples = 0;
    this.healthySamples = 0;
    this.congestedSamples = 0;
    this.highFallbackUsed = false;
    this.preferredCodec = this.capabilities.codecPreferences.includes("high") ? "high" : "baseline";
    return this.current("session-reset");
  }

  selectCodec(receiverProfiles: readonly RemoteVideoH264Profile[]): RemoteVideoH264Profile {
    const senderProfiles = this.capabilities.codecPreferences;
    this.preferredCodec = !this.highFallbackUsed
      && senderProfiles.includes("high")
      && receiverProfiles.includes("high")
      ? "high"
      : "baseline";
    return this.preferredCodec;
  }

  fallbackCodec(failed: RemoteVideoH264Profile): RemoteVideoH264Profile | null {
    if (failed !== "high" || this.highFallbackUsed) return null;
    this.highFallbackUsed = true;
    this.preferredCodec = "baseline";
    return "baseline";
  }

  current(reason = "steady"): RemoteVideoDecision {
    return {
      quality: this.quality,
      bitRate: this.bitRate,
      maxFps: this.capabilities.dynamicFrameRate ? Math.min(this.activityFps, this.pressureFps) : 30,
      maintainResolution: true,
      preferredCodec: this.preferredCodec,
      reason,
    };
  }

  update(observation: RemoteVideoObservation = {}): RemoteVideoDecision {
    const now = finite(observation.now, observation.content?.observedAt ?? Date.now());
    this.updateActivity(observation, now);

    const network = observation.network ?? {};
    const encoder = observation.encoder;
    const lossRate = clamp(finite(network.lossRate), 0, 1);
    const rttMs = Math.max(0, finite(network.rttMs));
    const droppedFrames = Math.max(0, finite(network.droppedFrames));
    const availableBitrate = Math.max(0, finite(network.availableOutgoingBitrate));
    const severeNetwork = lossRate >= 0.12 || rttMs >= 500 || droppedFrames >= 8;
    const throughputPressure = availableBitrate > 0 && availableBitrate < this.bitRate * 0.72;
    const networkPressure = severeNetwork || lossRate >= 0.05 || rttMs >= 250 || droppedFrames > 0 || throughputPressure;

    const frameIntervalMs = 1_000 / Math.max(5, Math.min(this.activityFps, this.pressureFps));
    const encoderPressure = Boolean(encoder) && (
      finite(encoder?.pendingFrames) >= 3
      || finite(encoder?.encodeLatencyMs) > frameIntervalMs * 2
      || finite(encoder?.droppedFrames) > 0
    );

    if (networkPressure || encoderPressure) {
      this.healthySamples = 0;
      this.congestedSamples += 1;
      if (networkPressure && this.capabilities.dynamicBitrate) {
        const profile = REMOTE_VIDEO_PROFILES[this.quality];
        const measuredCeiling = availableBitrate > 0 ? Math.floor(availableBitrate * 0.9) : this.bitRate;
        const reduced = Math.floor(this.bitRate * (severeNetwork ? 0.65 : 0.82));
        this.bitRate = Math.max(profile.minBitRate, Math.min(reduced, measuredCeiling || reduced));
      }
      if (encoderPressure || this.congestedSamples >= 2) {
        this.pressureFps = lowerFps(this.pressureFps);
        this.congestedSamples = 0;
      }
      return this.current(encoderPressure ? "encoder-pressure" : severeNetwork ? "severe-congestion" : "congestion");
    }

    this.congestedSamples = 0;
    this.healthySamples += 1;
    if (this.healthySamples < 3) return this.current();
    this.healthySamples = 0;
    if (this.capabilities.dynamicBitrate) {
      const profile = REMOTE_VIDEO_PROFILES[this.quality];
      this.bitRate = Math.min(profile.maxBitRate, Math.max(this.bitRate + 100_000, Math.floor(this.bitRate * 1.12)));
    }
    if (this.capabilities.dynamicFrameRate) this.pressureFps = raiseFps(this.pressureFps);
    return this.current("recovery");
  }

  private updateActivity(observation: RemoteVideoObservation, now: number): void {
    const content = observation.content;
    if (!content || clamp(content.confidence, 0, 1) < 0.6) return;
    if (content.activity === "motion") {
      this.idleSince = null;
      this.motionSamples += 1;
      if (this.motionSamples >= 2) this.activityFps = 30;
      return;
    }
    this.motionSamples = 0;
    if (content.activity === "interactive") {
      this.idleSince = null;
      this.activityFps = Math.max(this.activityFps, 15);
      return;
    }
    if (this.idleSince === null) this.idleSince = now;
    if (now - this.idleSince >= 3_000) this.activityFps = 5;
  }
}
