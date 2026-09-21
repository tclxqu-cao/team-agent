import {
  RemoteVideoPolicy,
  type RemoteVideoDecision,
  type RemoteVideoH264Profile,
  type RemoteVideoObservation,
  type RemoteVideoQuality,
} from "@agent/core";

export interface BrowserVideoCodecLike {
  mimeType?: string;
  sdpFmtpLine?: string;
}

export function h264ProfilesFromCodecs(codecs: readonly BrowserVideoCodecLike[] | undefined): RemoteVideoH264Profile[] {
  const profiles = new Set<RemoteVideoH264Profile>();
  for (const codec of codecs ?? []) {
    if (codec.mimeType?.toLowerCase() !== "video/h264") continue;
    const profileLevelId = /(?:^|;)\s*profile-level-id=([0-9a-f]{6})/i.exec(codec.sdpFmtpLine ?? "")?.[1]?.toLowerCase();
    if (profileLevelId?.startsWith("64")) profiles.add("high");
    if (!profileLevelId || profileLevelId.startsWith("42")) profiles.add("baseline");
  }
  return [...profiles];
}

export class BrowserRemoteVideoPolicy {
  private readonly policy: RemoteVideoPolicy;
  private receiverProfiles: RemoteVideoH264Profile[] = ["baseline"];
  private senderProfiles: RemoteVideoH264Profile[] = ["baseline"];

  constructor(quality: RemoteVideoQuality = "original") {
    this.policy = new RemoteVideoPolicy(quality, {
      dynamicBitrate: true,
      dynamicFrameRate: true,
      encoderQueueTelemetry: false,
      explicitH264Profile: false,
      codecPreferences: ["high", "baseline"],
    });
  }

  begin(receiverProfiles: readonly RemoteVideoH264Profile[] = ["baseline"]): RemoteVideoDecision {
    this.receiverProfiles = receiverProfiles.length ? [...receiverProfiles] : ["baseline"];
    this.senderProfiles = ["baseline"];
    this.policy.resetSession();
    return this.policy.current("browser-start");
  }

  configureSender(senderProfiles: readonly RemoteVideoH264Profile[]): RemoteVideoDecision {
    this.senderProfiles = senderProfiles.length ? [...senderProfiles] : ["baseline"];
    const intersection = this.receiverProfiles.filter(profile => this.senderProfiles.includes(profile));
    this.policy.selectCodec(intersection.length ? intersection : ["baseline"]);
    return this.policy.current("codec-capabilities");
  }

  setQuality(quality: RemoteVideoQuality): RemoteVideoDecision {
    return this.policy.setQuality(quality);
  }

  observe(observation: RemoteVideoObservation): RemoteVideoDecision {
    return this.policy.update(observation);
  }

  fallback(failed: RemoteVideoH264Profile): RemoteVideoDecision | null {
    return this.policy.fallbackCodec(failed) ? this.policy.current("codec-fallback") : null;
  }

  current(reason?: string): RemoteVideoDecision {
    return this.policy.current(reason);
  }
}
