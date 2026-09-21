export interface RemoteVideoStatsSample {
  codec?: string;
  decoder?: string;
  width?: number;
  height?: number;
  fps?: number;
  rttMs?: number;
  jitterMs?: number;
  lossRate?: number;
  droppedFrames?: number;
  receiveBitrate?: number;
  availableBitrate?: number;
  candidateType?: "host" | "srflx" | "prflx" | "relay";
  protocol?: "udp" | "tcp";
}

export interface RemoteVideoStatsCursor {
  at: number;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  framesDropped: number;
}

type StatsLike = Iterable<Record<string, unknown>> | {
  values(): Iterable<Record<string, unknown>>;
};
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function readRemoteVideoStats(report: StatsLike, previous: RemoteVideoStatsCursor | null, now = Date.now()): { sample: RemoteVideoStatsSample; cursor: RemoteVideoStatsCursor } | null {
  const source = typeof (report as { values?: unknown }).values === "function"
    ? (report as { values(): Iterable<Record<string, unknown>> }).values()
    : report as Iterable<Record<string, unknown>>;
  const values = [...source];
  const inbound = values.find(item => item.type === "inbound-rtp" && (item.kind === "video" || item.mediaType === "video"));
  if (!inbound) return null;
  const codec = values.find(item => item.id === inbound.codecId);
  const pair = values.find(item => item.type === "candidate-pair" && item.state === "succeeded" && (item.nominated === true || item.selected === true));
  const local = values.find(item => item.id === pair?.localCandidateId);
  const remote = values.find(item => item.id === pair?.remoteCandidateId);
  const candidateTypes = [local?.candidateType, remote?.candidateType].map(String);
  const candidateType = (["relay", "srflx", "prflx", "host"].find(type => candidateTypes.includes(type)) ?? undefined) as RemoteVideoStatsSample["candidateType"];
  const bytesReceived = finite(inbound.bytesReceived) ?? 0;
  const packetsReceived = finite(inbound.packetsReceived) ?? 0;
  const packetsLost = finite(inbound.packetsLost) ?? 0;
  const framesDropped = finite(inbound.framesDropped) ?? 0;
  const elapsedMs = previous ? Math.max(1, now - previous.at) : 0;
  const packetDelta = previous ? Math.max(0, packetsReceived - previous.packetsReceived) : 0;
  const lossDelta = previous ? Math.max(0, packetsLost - previous.packetsLost) : 0;
  const droppedDelta = previous ? Math.max(0, framesDropped - previous.framesDropped) : 0;
  const pairRtt = finite(pair?.currentRoundTripTime);
  const jitter = finite(inbound.jitter);
  const sample: RemoteVideoStatsSample = {
    codec: typeof codec?.mimeType === "string" ? codec.mimeType.replace(/^video\//i, "") : undefined,
    decoder: typeof inbound.decoderImplementation === "string" ? inbound.decoderImplementation.slice(0, 120) : undefined,
    width: finite(inbound.frameWidth), height: finite(inbound.frameHeight), fps: finite(inbound.framesPerSecond),
    rttMs: pairRtt !== undefined ? pairRtt * 1000 : undefined,
    jitterMs: jitter !== undefined ? jitter * 1000 : undefined,
    lossRate: packetDelta + lossDelta > 0 ? lossDelta / (packetDelta + lossDelta) : 0,
    droppedFrames: droppedDelta,
    receiveBitrate: previous ? Math.max(0, Math.round((bytesReceived - previous.bytesReceived) * 8_000 / elapsedMs)) : undefined,
    availableBitrate: finite(pair?.availableIncomingBitrate),
    candidateType,
    protocol: local?.protocol === "tcp" || remote?.protocol === "tcp" ? "tcp" : (pair ? "udp" : undefined),
  };
  for (const key of Object.keys(sample) as Array<keyof RemoteVideoStatsSample>) if (sample[key] === undefined) delete sample[key];
  return { sample, cursor: { at: now, bytesReceived, packetsReceived, packetsLost, framesDropped } };
}

export function formatRemoteVideoStats(sample: RemoteVideoStatsSample | null): string | null {
  if (!sample) return null;
  const parts: Array<string | null> = [sample.candidateType === "relay" ? "TURN 中继" : sample.candidateType ? "P2P 直连" : null];
  if (sample.codec) parts.push(sample.codec);
  if (sample.width && sample.height) parts.push(`${sample.width}x${sample.height}${sample.fps ? `@${Math.round(sample.fps)}` : ""}`);
  if (sample.receiveBitrate) parts.push(`${(sample.receiveBitrate / 1_000_000).toFixed(1)}Mbps`);
  if (sample.rttMs !== undefined) parts.push(`${Math.round(sample.rttMs)}ms`);
  return parts.filter(Boolean).join(" · ") || null;
}
