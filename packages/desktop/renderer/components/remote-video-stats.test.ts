import { describe, expect, it } from "vitest";
import { formatRemoteVideoStats, readRemoteVideoStats } from "./remote-video-stats";

describe("remote video stats", () => {
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
});
