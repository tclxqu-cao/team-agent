import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRemoteVideoDecoder,
  formatRemoteVideoStats,
  h264ProfilesFromReceiverCodecs,
  readReceiverH264Profiles,
  readRemoteVideoStats,
} from "./remote-video-stats";

describe("remote video stats", () => {
  afterEach(() => vi.unstubAllGlobals());

  const base = [
    { id: "codec", type: "codec", mimeType: "video/H264" },
    { id: "local", type: "local-candidate", candidateType: "host", protocol: "udp" },
    { id: "remote", type: "remote-candidate", candidateType: "relay", protocol: "udp" },
    { id: "pair", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: 0.042, availableIncomingBitrate: 6_000_000 },
  ];

  it("derives bitrate, loss, dropped frames and relay diagnostics from browser stats", () => {
    const firstValues = [...base, { id: "in", type: "inbound-rtp", kind: "video", codecId: "codec", bytesReceived: 1000, packetsReceived: 100, packetsLost: 2, framesDropped: 1 }];
    const secondValues = [...base, { id: "in", type: "inbound-rtp", kind: "video", codecId: "codec", bytesReceived: 501000, packetsReceived: 190, packetsLost: 12, framesDropped: 3, frameWidth: 2560, frameHeight: 1440, framesPerSecond: 30 }];
    const first = readRemoteVideoStats(new Map(firstValues.map(item => [item.id, item])), null, 1000)!;
    const second = readRemoteVideoStats(new Map(secondValues.map(item => [item.id, item])), first.cursor, 2000)!;
    expect(second.sample).toMatchObject({ codec: "H264", candidateType: "relay", protocol: "udp", receiveBitrate: 4_000_000, availableBitrate: 6_000_000, lossRate: 0.1, droppedFrames: 2, rttMs: 42 });
    expect(formatRemoteVideoStats(second.sample)).toBe("TURN 中继 · H264 · 2560x1440@30 · 4.0Mbps · 42ms");
  });

  it("classifies decoder acceleration only from explicit browser evidence", () => {
    const values = [...base, {
      id: "in", type: "inbound-rtp", kind: "video", codecId: "codec", bytesReceived: 1,
      packetsReceived: 1, packetsLost: 0, framesDropped: 0,
      decoderImplementation: "VideoToolbox (hardware-looking name)", powerEfficientDecoder: true,
    }];
    const hardware = readRemoteVideoStats(values, null, 1_000)!.sample;
    expect(hardware.decoder).toEqual({ implementation: "VideoToolbox (hardware-looking name)", powerEfficient: true, acceleration: "hardware" });
    expect(formatRemoteVideoDecoder(hardware)).toBe("硬件解码 · VideoToolbox (hardware-looking name)");
    const unknownValues = values.map(item => item.id === "in" ? { ...item, powerEfficientDecoder: undefined } : item);
    const unknown = readRemoteVideoStats(unknownValues, null, 1_000)!.sample;
    expect(unknown.decoder?.acceleration).toBe("unknown");
    expect(formatRemoteVideoDecoder(unknown)).toContain("解码方式未知");
    const softwareValues = values.map(item => item.id === "in" ? { ...item, powerEfficientDecoder: false } : item);
    expect(readRemoteVideoStats(softwareValues, null, 1_000)!.sample.decoder?.acceleration).toBe("software");
  });

  it("bounds implementation text and derives receiver H264 profiles", () => {
    const values = [...base, { id: "in", type: "inbound-rtp", kind: "video", codecId: "codec", bytesReceived: 1, packetsReceived: 1, packetsLost: 0, framesDropped: 0, decoderImplementation: "x".repeat(200) }];
    expect(readRemoteVideoStats(values, null, 1_000)!.sample.decoder?.implementation).toHaveLength(120);
    expect(h264ProfilesFromReceiverCodecs([
      { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=640034" },
      { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42e01f" },
      { mimeType: "video/VP9" },
    ])).toEqual(["high", "baseline"]);
  });

  it("falls back to baseline when receiver capabilities expose no H264 codec", () => {
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/VP9" }] }),
    });

    expect(readReceiverH264Profiles()).toEqual(["baseline"]);
  });
});
