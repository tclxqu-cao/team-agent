import { normalizeNativeCompoundFrame, normalizeNativeCompoundSample } from './native-compound-video.mjs';
import * as liveView from '@agent/core';

export class NativeVideoEncoder {
  constructor({ helper, highProfile = true }) {
    this.helper = helper;
    this.highProfile = highProfile;
    this.legacyVideo = helper.videoProtocolVersion === 1;
  }

  capabilities() {
    if (Number.isInteger(this.helper.videoProtocolVersion)) this.legacyVideo = this.helper.videoProtocolVersion < 2;
    return {
      dynamicBitrate: !this.legacyVideo,
      dynamicFrameRate: !this.legacyVideo,
      dynamicResolution: !this.legacyVideo && this.resolutionSupported === true,
      encoderQueueTelemetry: !this.legacyVideo,
      explicitH264Profile: this.highProfile && !this.legacyVideo,
      codecPreferences: this.highProfile && !this.legacyVideo ? ['high', 'baseline'] : ['baseline'],
      compoundVideo: !this.legacyVideo && typeof this.helper.onCompound === 'function',
    };
  }

  onFrame(listener) {
    return this.helper.onVideo?.(listener) ?? (() => undefined);
  }

  onCompound(listener) {
    return this.helper.onCompound?.(input => {
      const frame = normalizeNativeCompoundFrame(input);
      listener(frame ?? { unsupported: true });
    }) ?? (() => undefined);
  }

  onCursor(listener) { return this.helper.onCursor?.(message => {
    if (message && Number.isSafeInteger(message.sequence) && [message.x, message.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
      && typeof message.active === 'boolean' && typeof message.visible === 'boolean') listener(message);
  }) ?? (() => {}); }

  async enableCursor(enabled) {
    const result = await this.helper.request({ op: 'cursor-enable', enabled });
    if (enabled && result?.version !== 1) throw new Error('Independent cursor unavailable');
  }

  async enableCompound(enabled) {
    const reply = await this.helper.request({ op: 'compound-enable', enabled });
    if (enabled && (reply?.version !== 1 || reply.codec !== 'png')) throw new Error('Compound capture unsupported');
  }

  async sampleCompound(maxBytes, { maxEntropy = liveView.REMOTE_COMPOUND_VIDEO.initialEntropy, priorityIndices = [], selectedOnly = false } = {}) {
    return normalizeNativeCompoundSample(await this.helper.request({
      op: 'compound-sample', maxBytes, maxEntropy, priorityIndices, ...(selectedOnly ? { selectedOnly: true } : {}),
    }));
  }

  async start({ profile, decision }) {
    if (this.legacyVideo) {
      if (profile !== 'baseline') throw new Error('Legacy video helper supports Baseline only');
      await this.helper.request({ op: 'video', enabled: true });
      return;
    }
    try {
      this.resolutionConfigured = decision.maxEdge !== undefined;
      const reply = await this.helper.request({ op: 'video-start', profile, bitRate: decision.bitRate, maxFps: decision.maxFps,
        ...(decision.maxEdge !== undefined || this.resolutionConfigured ? { maxEdge: decision.maxEdge ?? 0 } : {}),
        ...liveView.remoteVideoEncodeAdmission(decision.maxFps), keyFrameInterval: liveView.remoteVideoKeyframeInterval(decision.maxFps, decision.reason) });
      this.resolutionSupported = reply?.adaptiveResolutionVersion === 1;
    } catch (error) {
      if (profile === 'high') throw error;
      await this.helper.request({ op: 'video', enabled: true });
      this.legacyVideo = true;
    }
  }

  apply(decision) {
    if (this.legacyVideo) return Promise.resolve();
    const resolution = decision.maxEdge !== undefined || this.resolutionConfigured ? { maxEdge: decision.maxEdge ?? 0 } : {};
    return this.helper.request({ op: 'video-tuning', bitRate: decision.bitRate, maxFps: decision.maxFps, ...resolution,
      ...liveView.remoteVideoEncodeAdmission(decision.maxFps), keyFrameInterval: liveView.remoteVideoKeyframeInterval(decision.maxFps, decision.reason) }).then(reply => {
        this.resolutionConfigured = decision.maxEdge !== undefined;
        return reply;
      });
  }

  requestKeyframe() {
    return this.helper.request({ op: 'video', enabled: true });
  }

  async snapshot() {
    if (this.legacyVideo) return null;
    try {
      const result = await this.helper.request({ op: 'video-stats' });
      if (!result || result.ok === false) return null;
      const telemetry = {
        pendingFrames: Number.isFinite(result.pendingFrames) ? result.pendingFrames : undefined,
        queuedFrames: Number.isFinite(result.queuedFrames) ? result.queuedFrames : undefined,
        coalescedFrames: Number.isFinite(result.coalescedFrames) ? result.coalescedFrames : undefined,
        admissionLimit: Number.isFinite(result.admissionLimit) ? result.admissionLimit : undefined,
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
