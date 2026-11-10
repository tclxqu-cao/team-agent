import { describe, expect, it } from "vitest";
import { REMOTE_VIDEO_PROFILES, RemoteVideoPolicy } from "./remote-video-policy.js";

const nativeCapabilities = {
  encoderQueueTelemetry: true,
  explicitH264Profile: true,
  codecPreferences: ["high", "baseline"] as const,
};

describe("RemoteVideoPolicy", () => {
  it("uses the same pressure evidence for urgent feedback without counting healthy checks as recovery", () => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    expect(policy.hasNetworkPressure({ rttMs: 600, lossRate: 0, availableOutgoingBitrate: 7_000 })).toBe(false);
    expect(policy.hasNetworkPressure({ rttMs: 30, lossRate: 0.2 })).toBe(true);
    policy.update({ network: { rttMs: 30, lossRate: 0.2 } });
    const reduced = policy.current().bitRate;
    for (let index = 0; index < 20; index += 1) {
      expect(policy.hasNetworkPressure({ rttMs: 30, lossRate: 0, availableOutgoingBitrate: 20_000_000 })).toBe(false);
    }
    expect(policy.current().bitRate).toBe(reduced);
  });

  it("uses FPS for local backlog on a healthy path while preserving unknown-path backoff", () => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    const sender = { queuedBytes: 80_000, queuedFrames: 4, queueDelayMs: 180, droppedFrames: 0, pacingBitRate: 10_000_000, waitingForKeyframe: false };
    expect(policy.update({ sender, network: { rttMs: 600, lossRate: 0, availableOutgoingBitrate: 20_000_000 } }))
      .toMatchObject({ bitRate: 8_000_000, maxFps: 30, reason: "sender-pressure", maintainResolution: true });
    expect(policy.update({ sender: { ...sender, queueDelayMs: 0, droppedFrames: 1 } }).maxFps).toBe(15);
  });

  it("does not collapse bitrate after repeated local drops with fresh healthy transport evidence", () => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    for (let index = 0; index < 60; index++) policy.update({ network: { rttMs: index % 2 ? 10 : 0, lossRate: 0 },
      sender: { queuedBytes: 50_000, queuedFrames: 2, queueDelayMs: 180, droppedFrames: 2, pacingBitRate: 10_000_000, waitingForKeyframe: false } });
    expect(policy.current()).toMatchObject({ bitRate: 8_000_000, maxFps: 5 });
    expect(policy.update({ network: { rttMs: 300, lossRate: .1 } }).bitRate).toBeLessThan(8_000_000);
  });

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
    expect(policy.update({ now: 3_000, content: { activity: "idle", confidence: 1, observedAt: 3_000 } }).maxFps).toBe(15);
    expect(policy.update({ now: 3_100, content: { activity: "interactive", confidence: 1, observedAt: 3_100 } }).maxFps).toBe(15);
    expect(policy.update({ now: 3_200, content: { activity: "motion", confidence: 1, observedAt: 3_200 } }).maxFps).toBe(15);
    expect(policy.update({ now: 3_300, content: { activity: "motion", confidence: 1, observedAt: 3_300 } }).maxFps).toBe(30);
  });

  it("restores the activity target immediately on remote interaction without clearing pressure", () => {
    const healthy = new RemoteVideoPolicy("hd", nativeCapabilities);
    healthy.update({ now: 0, content: { activity: "idle", confidence: 1, observedAt: 0 } });
    healthy.update({ now: 3_000, content: { activity: "idle", confidence: 1, observedAt: 3_000 } });
    expect(healthy.noteInteraction()).toMatchObject({ maxFps: 30, reason: "interaction" });

    const pressured = new RemoteVideoPolicy("hd", nativeCapabilities);
    pressured.update({ encoder: { pendingFrames: 3, encodeLatencyMs: 70, droppedFrames: 0, sampledAt: 1 } });
    expect(pressured.noteInteraction()).toMatchObject({ maxFps: 15, reason: "interaction" });
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
    for (let index = 0; index < 6; index += 1) policy.update({});
    expect(policy.current().maxFps).toBe(5);
    policy.update({ network: { lossRate: 0, rttMs: 20 } });
    policy.update({ network: { lossRate: 0, rttMs: 20 } });
    expect(policy.update({ network: { lossRate: 0, rttMs: 20 } }).reason).toBe("recovery");
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

  it("does not collapse FPS on the measured sparse-stream REMB and still reacts to real pressure", () => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    for (let index = 0; index < 20; index += 1) {
      policy.update({ network: { lossRate: 0, rttMs: 2, availableOutgoingBitrate: 7_000 },
        encoder: { pendingFrames: 0, encodeLatencyMs: 12, sampledAt: index } });
    }
    expect(policy.noteInteraction()).toMatchObject({ maxFps: 30, bitRate: 8_000_000 });
    for (let index = 0; index < 4; index += 1) policy.update({ network: { lossRate: 0.08, rttMs: 280, availableOutgoingBitrate: 7_000 } });
    expect(policy.current().maxFps).toBe(5);
    for (let index = 0; index < 6; index += 1) policy.update({ network: { lossRate: 0, rttMs: 2, availableOutgoingBitrate: 7_000 } });
    expect(policy.current().maxFps).toBe(30);
    expect(policy.resetSession().bitRate).toBe(8_000_000);
  });

  it("distinguishes stable cellular RTT from queue growth", () => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    for (let n = 0; n < 8; n++) policy.update({network:{lossRate:0,rttMs:120,availableOutgoingBitrate:7000}});
    expect(policy.current().maxFps).toBe(30);
    for (let n = 0; n < 2; n++) policy.update({network:{lossRate:0,rttMs:230,availableOutgoingBitrate:7000}});
    expect(policy.current().maxFps).toBe(15);
  });

  it.each([
    [280, 20_000_000], [600, 20_000_000], [280, 7_000], [600, 7_000],
  ])("keeps stable %dms paths responsive with a %d bps estimate", (rttMs, availableOutgoingBitrate) => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    for (let index = 0; index < 15; index += 1) {
      policy.update({ now: index * 2_000,
        network: { rttMs, lossRate: 0, droppedFrames: 0, availableOutgoingBitrate },
        content: { activity: "motion", confidence: 1, observedAt: index * 2_000 } });
    }
    expect(policy.current()).toMatchObject({ bitRate: 8_000_000, maxFps: 30 });
  });

  it("does not treat a clean path RTT change as bandwidth exhaustion", () => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    policy.update({ network: { rttMs: 20, lossRate: 0, availableOutgoingBitrate: 20_000_000 } });
    for (let index = 0; index < 15; index += 1) {
      policy.update({ network: { rttMs: 280, lossRate: 0, availableOutgoingBitrate: 20_000_000 } });
    }
    expect(policy.current()).toMatchObject({ bitRate: 8_000_000, maxFps: 30 });
  });

  it("still backs off for real loss and recovers when a high-RTT path becomes healthy", () => {
    const policy = new RemoteVideoPolicy("hd", nativeCapabilities);
    for (let index = 0; index < 8; index += 1) {
      policy.update({ network: { rttMs: 280, lossRate: 0.4, availableOutgoingBitrate: 2_000_000 } });
    }
    const congested = policy.current();
    expect(congested).toMatchObject({ bitRate: 1_000_000, maxFps: 5 });
    for (let index = 0; index < 6; index += 1) {
      policy.update({ network: { rttMs: 280, lossRate: 0, availableOutgoingBitrate: 20_000_000 } });
    }
    expect(policy.current().maxFps).toBe(30);
    expect(policy.current().bitRate).toBeGreaterThan(congested.bitRate);
  });
});
