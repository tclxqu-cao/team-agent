export interface RemoteAudioCapabilities {
    fullDuplex: boolean;
    systemAudio: boolean;
    microphonePlayback: boolean;
    selfPlaybackExclusion: boolean;
}
export type RemoteAudioState = "idle" | "starting" | "live" | "failed";
export interface RemoteAudioSnapshot {
    state: RemoteAudioState;
    microphoneMuted: boolean;
    speakerMuted: boolean;
    foreground: boolean;
    controller: boolean;
    error?: string;
}
export type RemoteAudioAction = {
    type: "start";
} | {
    type: "connected";
} | {
    type: "stop";
} | {
    type: "failed";
    error: string;
} | {
    type: "set-microphone-muted";
    muted: boolean;
} | {
    type: "set-speaker-muted";
    muted: boolean;
} | {
    type: "set-foreground";
    foreground: boolean;
} | {
    type: "set-controller";
    controller: boolean;
};
export type RemoteAudioDispatchResult = {
    accepted: true;
    snapshot: RemoteAudioSnapshot;
} | {
    accepted: false;
    reason: "unsupported" | "not-controller" | "background";
    snapshot: RemoteAudioSnapshot;
};
/** Transport-independent full-duplex voice state for one remote controller. */
export declare class RemoteAudioSession {
    private readonly capabilities;
    private snapshot;
    constructor(capabilities: RemoteAudioCapabilities, initial?: Partial<Pick<RemoteAudioSnapshot, "foreground" | "controller">>);
    getSnapshot(): RemoteAudioSnapshot;
    dispatch(action: RemoteAudioAction): RemoteAudioDispatchResult;
    private toIdle;
    private accepted;
    private rejected;
}
//# sourceMappingURL=remote-audio.d.ts.map