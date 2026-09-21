export class NativeVideoEncoder {
  constructor({ helper, highProfile = true }) {
    this.helper = helper;
    this.highProfile = highProfile;
  }

  capabilities() {
    return {
      dynamicBitrate: true,
      dynamicFrameRate: true,
      encoderQueueTelemetry: true,
      explicitH264Profile: this.highProfile,
      codecPreferences: this.highProfile ? ['high', 'baseline'] : ['baseline'],
    };
  }

  onFrame(listener) {
    return this.helper.onVideo?.(listener) ?? (() => undefined);
  }

  async start({ profile, decision }) {
    try {
      await this.helper.request({ op: 'video-start', profile, bitRate: decision.bitRate, maxFps: decision.maxFps });
    } catch (error) {
      if (profile === 'high') throw error;
      await this.helper.request({ op: 'video', enabled: true });
      await this.apply(decision);
    }
  }

  apply(decision) {
    return this.helper.request({ op: 'video-tuning', bitRate: decision.bitRate, maxFps: decision.maxFps });
  }

  requestKeyframe() {
    return this.helper.request({ op: 'video', enabled: true });
  }

  async snapshot() {
    try {
      const result = await this.helper.request({ op: 'video-stats' });
      if (!result || result.ok === false) return null;
      const telemetry = {
        pendingFrames: Number.isFinite(result.pendingFrames) ? result.pendingFrames : undefined,
        encodeLatencyMs: Number.isFinite(result.encodeLatencyMs) ? result.encodeLatencyMs : undefined,
        droppedFrames: Number.isFinite(result.droppedFrames) ? result.droppedFrames : undefined,
        sequence: Number.isFinite(result.sequence) ? result.sequence : undefined,
        sampledAt: Number.isFinite(result.sampledAt) ? result.sampledAt : Date.now(),
      };
      const content = ['idle', 'interactive', 'motion'].includes(result.activity)
        ? { activity: result.activity, confidence: Number.isFinite(result.activityConfidence) ? result.activityConfidence : 0, observedAt: telemetry.sampledAt }
        : undefined;
      return { telemetry, content };
    } catch {
      return null;
    }
  }

  stop() {
    return this.helper.request({ op: 'video', enabled: false }).catch(() => undefined);
  }
}
