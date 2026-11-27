import { type RemoteVideoDecision, type RemoteVideoH264Profile, type RemoteVideoObservation, type RemoteVideoQuality } from "@agent/core";
export interface BrowserVideoCodecLike {
    mimeType?: string;
    sdpFmtpLine?: string;
}
export declare function h264ProfilesFromCodecs(codecs: readonly BrowserVideoCodecLike[] | undefined): RemoteVideoH264Profile[];
export declare class BrowserRemoteVideoPolicy {
    private readonly policy;
    private receiverProfiles;
    private senderProfiles;
    constructor(quality?: RemoteVideoQuality);
    begin(receiverProfiles?: readonly RemoteVideoH264Profile[]): RemoteVideoDecision;
    configureSender(senderProfiles: readonly RemoteVideoH264Profile[]): RemoteVideoDecision;
    setQuality(quality: RemoteVideoQuality): RemoteVideoDecision;
    observe(observation: RemoteVideoObservation): RemoteVideoDecision;
    fallback(failed: RemoteVideoH264Profile): RemoteVideoDecision | null;
    current(reason?: string): RemoteVideoDecision;
}
//# sourceMappingURL=remote-video-browser-policy.d.ts.map