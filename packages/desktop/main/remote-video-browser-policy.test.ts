import { describe, expect, it } from "vitest";
import { BrowserRemoteVideoPolicy, h264ProfilesFromCodecs } from "./remote-video-browser-policy.js";

describe("BrowserRemoteVideoPolicy", () => {
  it("extracts only supported H264 profiles from browser codec capabilities", () => {
    expect(h264ProfilesFromCodecs([
      { mimeType: "video/VP8" },
      { mimeType: "video/H264", sdpFmtpLine: "packetization-mode=1;profile-level-id=640034" },
      { mimeType: "video/H264", sdpFmtpLine: "packetization-mode=1;profile-level-id=42e01f" },
    ])).toEqual(["high", "baseline"]);
  });

  it("chooses High only from the sender/receiver intersection and falls back once", () => {
    const policy = new BrowserRemoteVideoPolicy();
    policy.begin(["high", "baseline"]);
    expect(policy.configureSender(["high", "baseline"]).preferredCodec).toBe("high");
    expect(policy.fallback("high")?.preferredCodec).toBe("baseline");
    expect(policy.fallback("high")).toBeNull();
  });

  it("uses browser observations without claiming queue telemetry", () => {
    const policy = new BrowserRemoteVideoPolicy();
    policy.begin(["baseline"]);
    policy.configureSender(["baseline"]);
    policy.observe({ now: 0, content: { activity: "idle", confidence: 1, observedAt: 0 } });
    expect(policy.observe({ now: 3_000, content: { activity: "idle", confidence: 1, observedAt: 3_000 } }).maxFps).toBe(5);
    expect(policy.observe({ encoder: { encodeLatencyMs: 500, sampledAt: 3_100 } }).reason).toBe("encoder-pressure");
  });
});
