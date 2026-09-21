import { describe, expect, it } from "vitest";
import { REMOTE_VIDEO_PROFILES, RemoteVideoPolicy } from "./remote-video-policy.js";

const nativeCapabilities = {
  encoderQueueTelemetry: true,
  explicitH264Profile: true,
  codecPreferences: ["high", "baseline"] as const,
};

describe("RemoteVideoPolicy", () => {
  it("keeps quality as a bitrate ceiling and never changes resolution", () => {
    const policy = new RemoteVideoPolicy("smooth", nativeCapabilities);
    for (let index = 0; index < 12; index += 1) policy.update({ network: { lossRate: 0, rttMs: 30 } });
    expect(policy.current()).toMatchObject({
      bitRate: REMOTE_VIDEO_PROFILES.smooth.maxBitRate,
      maxFps: 30,
      quality: "smooth",
      maintainResolution: true,
    });
  });

  it("uses delayed idle demotion and fast interactive/motion promotion", () => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    policy.update({ now: 0, content: { activity: "idle", confidence: 1, observedAt: 0 } });
    expect(policy.update({ now: 2_999, content: { activity: "idle", confidence: 1, observedAt: 2_999 } }).maxFps).toBe(30);
    expect(policy.update({ now: 3_000, content: { activity: "idle", confidence: 1, observedAt: 3_000 } }).maxFps).toBe(5);
    expect(policy.update({ now: 3_100, content: { activity: "interactive", confidence: 1, observedAt: 3_100 } }).maxFps).toBe(15);
    expect(policy.update({ now: 3_200, content: { activity: "motion", confidence: 1, observedAt: 3_200 } }).maxFps).toBe(15);
    expect(policy.update({ now: 3_300, content: { activity: "motion", confidence: 1, observedAt: 3_300 } }).maxFps).toBe(30);
  });

  it("reduces bitrate for network congestion and fps for sustained pressure", () => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    const first = policy.update({ network: { lossRate: 0.08, rttMs: 280, availableOutgoingBitrate: 4_000_000 } });
    expect(first.bitRate).toBeLessThan(8_000_000);
    expect(first.maxFps).toBe(30);
    const second = policy.update({ network: { lossRate: 0.08, rttMs: 280, availableOutgoingBitrate: 3_000_000 } });
    expect(second.maxFps).toBe(15);
  });

  it("relieves encoder pressure by lowering fps without inventing queue data", () => {
    const policy = new RemoteVideoPolicy("original", nativeCapabilities);
    const pressured = policy.update({ encoder: { pendingFrames: 3, encodeLatencyMs: 70, droppedFrames: 0, sampledAt: 1 } });
    expect(pressured).toMatchObject({ maxFps: 15, bitRate: 20_000_000, reason: "encoder-pressure" });
    const browserPolicy = new RemoteVideoPolicy("hd", { encoderQueueTelemetry: false });
    expect(browserPolicy.update({}).maxFps).toBe(30);
  });

  it("recovers conservatively after three healthy samples", () => {
    const policy = new RemoteVideoPolicy("original", nativeCapabilities);
    for (let index = 0; index < 12; index += 1) policy.update({ network: { lossRate: 0.3, rttMs: 600 } });
    expect(policy.current().maxFps).toBe(5);
    policy.update({});
    policy.update({});
    expect(policy.update({}).reason).toBe("recovery");
    expect(policy.current().maxFps).toBe(15);
  });

  it("does not mistake missing or low receive bitrate for congestion", () => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    for (let index = 0; index < 6; index += 1) policy.update({ network: { lossRate: 0, rttMs: 30 } });
    expect(policy.current()).toMatchObject({ bitRate: 8_000_000, maxFps: 30 });
  });

  it("selects High only from a proven intersection and falls back once", () => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    expect(policy.selectCodec(["high", "baseline"])).toBe("high");
    expect(policy.fallbackCodec("high")).toBe("baseline");
    expect(policy.fallbackCodec("high")).toBeNull();
    expect(policy.selectCodec(["high", "baseline"])).toBe("baseline");
    policy.resetSession();
    expect(policy.selectCodec(["baseline"])).toBe("baseline");
  });
});
