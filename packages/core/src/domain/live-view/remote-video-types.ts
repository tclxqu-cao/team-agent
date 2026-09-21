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
}

export interface RemoteVideoEncoderTelemetry {
  pendingFrames?: number;
  encodeLatencyMs?: number;
  droppedFrames?: number;
  sequence?: number;
  sampledAt: number;
}

export interface RemoteVideoObservation {
  now?: number;
  content?: RemoteVideoContentSample;
  network?: RemoteVideoNetworkTelemetry;
  encoder?: RemoteVideoEncoderTelemetry;
}

export interface RemoteVideoAdapterCapabilities {
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
  maintainResolution: true;
  preferredCodec: RemoteVideoH264Profile;
  reason: string;
}

export interface RemoteVideoDecoderDiagnostics {
  implementation?: string;
  powerEfficient?: boolean;
  acceleration: RemoteVideoDecoderAcceleration;
}

export interface RemoteVideoReceiverStats {
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
