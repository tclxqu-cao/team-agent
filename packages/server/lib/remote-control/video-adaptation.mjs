export const VIDEO_PROFILES = Object.freeze({
  smooth: Object.freeze({ minBitRate: 500_000, maxBitRate: 2_000_000, maxFps: 30 }),
  hd: Object.freeze({ minBitRate: 1_000_000, maxBitRate: 8_000_000, maxFps: 30 }),
  original: Object.freeze({ minBitRate: 2_000_000, maxBitRate: 20_000_000, maxFps: 30 }),
});

const FPS_STEPS = [5, 10, 15, 20, 30];

function finite(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export class VideoAdaptation {
  constructor(quality = 'hd') {
    this.setQuality(quality);
  }

  setQuality(quality) {
    this.quality = VIDEO_PROFILES[quality] ? quality : 'hd';
    this.profile = VIDEO_PROFILES[this.quality];
    this.bitRate = this.profile.maxBitRate;
    this.maxFps = this.profile.maxFps;
    this.healthySamples = 0;
    this.congestedSamples = 0;
    return this.current('quality');
  }

  current(reason = 'steady') {
    return { quality: this.quality, bitRate: this.bitRate, maxFps: this.maxFps, reason };
  }

  update(sample = {}) {
    const lossRate = Math.max(0, Math.min(1, finite(sample.lossRate)));
    const rttMs = Math.max(0, finite(sample.rttMs));
    const droppedFrames = Math.max(0, finite(sample.droppedFrames));
    const availableBitrate = Math.max(0, finite(sample.availableBitrate));
    const severe = lossRate >= 0.12 || rttMs >= 500 || droppedFrames >= 8;
    // Actual receive bitrate drops naturally on a static desktop. Only an ICE
    // or receiver bandwidth estimate is evidence that the network is tight.
    const throughputPressure = availableBitrate > 0 && availableBitrate < this.bitRate * 0.72;
    const congested = severe || lossRate >= 0.05 || rttMs >= 250 || droppedFrames > 0 || throughputPressure;

    if (congested) {
      this.healthySamples = 0;
      this.congestedSamples += 1;
      const measuredCeiling = availableBitrate > 0 ? Math.floor(availableBitrate * 0.9) : this.bitRate;
      const reduced = Math.floor(this.bitRate * (severe ? 0.65 : 0.82));
      this.bitRate = Math.max(this.profile.minBitRate, Math.min(reduced, measuredCeiling || reduced));
      if (this.congestedSamples >= 2) {
        const index = Math.max(0, FPS_STEPS.findIndex((fps) => fps >= this.maxFps) - 1);
        this.maxFps = FPS_STEPS[index];
        this.congestedSamples = 0;
      }
      return this.current(severe ? 'severe-congestion' : 'congestion');
    }

    this.congestedSamples = 0;
    this.healthySamples += 1;
    if (this.healthySamples < 3) return this.current();
    this.healthySamples = 0;
    this.bitRate = Math.min(this.profile.maxBitRate, Math.max(this.bitRate + 100_000, Math.floor(this.bitRate * 1.12)));
    const index = FPS_STEPS.findIndex((fps) => fps >= this.maxFps);
    if (index >= 0 && index < FPS_STEPS.length - 1) this.maxFps = Math.min(this.profile.maxFps, FPS_STEPS[index + 1]);
    return this.current('recovery');
  }
}
