export type VoiceServiceEvent = {
    type: "keyword";
    sessionId: string;
    generation: number;
    keyword: string;
} | {
    type: "partial";
    sessionId: string;
    generation: number;
    text: string;
} | {
    type: "final";
    sessionId: string;
    generation: number;
    utteranceId: number;
    text: string;
} | {
    type: "finished";
    sessionId: string;
    generation: number;
};
export declare function isCurrentVoiceEvent(event: VoiceServiceEvent, current: {
    sessionId: string;
    generation: number;
}): boolean;
type VoiceMode = "wake" | "dictation" | "barge-in";
type AsrStart = {
    sessionId: string;
    generation: number;
    mode: VoiceMode;
    wakeWord?: string;
};
export declare class VoiceServiceClient {
    private readonly baseUrl;
    private readonly token;
    private socket;
    private current;
    private ready;
    constructor(options: {
        baseUrl: string;
        token: string | null;
    });
    startAsr(start: AsrStart, onEvent: (event: VoiceServiceEvent) => void, onDisconnect?: (error: Error) => void): Promise<void>;
    sendPcm(pcm: Buffer): void;
    finishAsr(): void;
    resetAsr(): void;
    stopAsr(): void;
    private sendControl;
    private closeAsr;
    close(): void;
}
export {};
//# sourceMappingURL=voice-service-client.d.ts.map