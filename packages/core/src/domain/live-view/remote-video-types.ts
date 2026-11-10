export type RemoteVideoQuality = "smooth" | "hd" | "original";
export type RemoteVideoContentActivity = "idle" | "interactive" | "motion";
export type RemoteVideoH264Profile = "high" | "baseline";
export type RemoteVideoDecoderAcceleration = "hardware" | "software" | "unknown";

export interface RemoteVideoContentSample {
  activity: RemoteVideoContentActivity;
  confidence: number;
  observedAt: number;
}

export interface RemoteVideoNetworkTelemetry {
  lossRate?: number;
  rttMs?: number;
  availableOutgoingBitrate?: number;
  droppedFrames?: number;
  applicationLimited?: boolean;
  congested?: boolean;
  bandwidthSource?: 'twcc' | 'remb';
}

export interface RemoteVideoEncoderTelemetry {
  pendingFrames?: number;
  queuedFrames?: number;
  coalescedFrames?: number;
  admissionLimit?: number;
  encodeLatencyMs?: number;
  droppedFrames?: number;
  sequence?: number;
  sampledAt: number;
}

export interface RemoteVideoSenderTelemetry {
  queuedBytes: number;
  queuedFrames: number;
  queueDelayMs: number;
  droppedFrames: number;
  pacingBitRate: number;
  supersededFrames?: number;
  waitingForKeyframe: boolean;
  queuedRepairBytes?: number;
  queuedRepairs?: number;
  historyBytes?: number;
  historyPackets?: number;
  repairedPackets?: number;
  repairedBytes?: number;
  recoveryRequests?: number;
  awaitingRecoveryKeyframe?: boolean;
  sentBytes?: number;
}

export interface RemoteVideoReceiverTelemetry {
  sequence: number;
  visible: boolean;
  intervalMs?: number;
  decodedFrames?: number;
  decodeMs?: number;
  droppedRatio?: number;
  presentationDelayMs?: number;
  jitterBufferMs?: number;
  jitterBufferTargetMs?: number;
  jitterBufferMinimumMs?: number;
  playoutTargetMs?: number;
  playoutControl?: boolean;
  width?: number;
  height?: number;
  viewport?: { width: number; height: number; pixelRatio: number; zoom: number };
}

export interface RemoteVideoObservation {
  now?: number;
  content?: RemoteVideoContentSample;
  receiver?: RemoteVideoReceiverTelemetry;
  network?: RemoteVideoNetworkTelemetry;
  encoder?: RemoteVideoEncoderTelemetry;
  sender?: RemoteVideoSenderTelemetry;
}

export interface RemoteVideoAdapterCapabilities {
  compoundVideo?: boolean;
  dynamicResolution?: boolean;
  dynamicBitrate: boolean;
  dynamicFrameRate: boolean;
  encoderQueueTelemetry: boolean;
  explicitH264Profile: boolean;
  codecPreferences: readonly RemoteVideoH264Profile[];
}

export interface RemoteVideoDecision {
  quality: RemoteVideoQuality;
  bitRate: number;
  maxFps: number;
  maintainResolution: boolean;
  maxEdge?: number;
  preferredCodec: RemoteVideoH264Profile;
  reason: string;
}

export interface RemoteVideoDecoderDiagnostics {
  implementation?: string;
  powerEfficient?: boolean;
  acceleration: RemoteVideoDecoderAcceleration;
}

export interface RemoteVideoReceiverStats {
  receiver?: RemoteVideoReceiverTelemetry;
  codec?: string;
  codecProfile?: RemoteVideoH264Profile;
  decoder?: RemoteVideoDecoderDiagnostics;
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
