import type { RemoteVideoAdapterCapabilities, RemoteVideoDecision, RemoteVideoH264Profile, RemoteVideoObservation, RemoteVideoQuality } from "./remote-video-types.js";
export declare const REMOTE_VIDEO_PROFILES: Readonly<{
    smooth: Readonly<{
        minBitRate: 500000;
        maxBitRate: 2000000;
    }>;
    hd: Readonly<{
        minBitRate: 1000000;
        maxBitRate: 8000000;
    }>;
    original: Readonly<{
        minBitRate: 2000000;
        maxBitRate: 20000000;
    }>;
}>;
export declare class RemoteVideoPolicy {
    readonly capabilities: RemoteVideoAdapterCapabilities;
    private quality;
    private bitRate;
    private activityFps;
    private pressureFps;
    private idleSince;
    private motionSamples;
    private healthySamples;
    private congestedSamples;
    private baselineRttMs;
    private preferredCodec;
    private highFallbackUsed;
    constructor(quality?: RemoteVideoQuality, capabilities?: Partial<RemoteVideoAdapterCapabilities>);
    setQuality(quality: RemoteVideoQuality): RemoteVideoDecision;
    resetSession(): RemoteVideoDecision;
    selectCodec(receiverProfiles: readonly RemoteVideoH264Profile[]): RemoteVideoH264Profile;
    fallbackCodec(failed: RemoteVideoH264Profile): RemoteVideoH264Profile | null;
    current(reason?: string): RemoteVideoDecision;
    noteInteraction(): RemoteVideoDecision;
    update(observation?: RemoteVideoObservation): RemoteVideoDecision;
    private updateActivity;
}
//# sourceMappingURL=remote-video-policy.d.ts.map