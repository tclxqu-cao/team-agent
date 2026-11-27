import { RemoteVideoPolicy, } from "@agent/core";
export function h264ProfilesFromCodecs(codecs) {
    const profiles = new Set();
    for (const codec of codecs ?? []) {
        if (codec.mimeType?.toLowerCase() !== "video/h264")
            continue;
        const profileLevelId = /(?:^|;)\s*profile-level-id=([0-9a-f]{6})/i.exec(codec.sdpFmtpLine ?? "")?.[1]?.toLowerCase();
        if (profileLevelId?.startsWith("64"))
            profiles.add("high");
        if (!profileLevelId || profileLevelId.startsWith("42"))
            profiles.add("baseline");
    }
    return [...profiles];
}
export class BrowserRemoteVideoPolicy {
    constructor(quality = "original") {
        this.receiverProfiles = ["baseline"];
        this.senderProfiles = ["baseline"];
        this.policy = new RemoteVideoPolicy(quality, {
            dynamicBitrate: true,
            dynamicFrameRate: true,
            dynamicResolution: true,
            encoderQueueTelemetry: false,
            explicitH264Profile: false,
            codecPreferences: ["high", "baseline"],
        });
    }
    begin(receiverProfiles = ["baseline"]) {
        this.receiverProfiles = receiverProfiles.length ? [...receiverProfiles] : ["baseline"];
        this.senderProfiles = ["baseline"];
        this.policy.resetSession();
        return this.policy.current("browser-start");
    }
    configureSender(senderProfiles) {
        this.senderProfiles = senderProfiles.length ? [...senderProfiles] : ["baseline"];
        const intersection = this.receiverProfiles.filter(profile => this.senderProfiles.includes(profile));
        this.policy.selectCodec(intersection.length ? intersection : ["baseline"]);
        return this.policy.current("codec-capabilities");
    }
    setQuality(quality) {
        return this.policy.setQuality(quality);
    }
    observe(observation) {
        return this.policy.update(observation);
    }
    fallback(failed) {
        return this.policy.fallbackCodec(failed) ? this.policy.current("codec-fallback") : null;
    }
    current(reason) {
        return this.policy.current(reason);
    }
}
//# sourceMappingURL=remote-video-browser-policy.js.map