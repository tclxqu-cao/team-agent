export interface RecognizerStreamLike {
    acceptWaveform(input: {
        samples: Float32Array;
        sampleRate: number;
    }): void;
    inputFinished(): void;
}
export interface RecognizerLike {
    createStream(): RecognizerStreamLike;
    isReady(stream: RecognizerStreamLike): boolean;
    decode(stream: RecognizerStreamLike): void;
    getResult(stream: RecognizerStreamLike): {
        text: string;
    };
    isEndpoint(stream: RecognizerStreamLike): boolean;
    reset(stream: RecognizerStreamLike): void;
}
export type AsrResultEvent = {
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
    type: "error";
    sessionId: string;
    generation: number;
    code: string;
    message: string;
};
export interface AsrSession {
    readonly ready?: Promise<void>;
    acceptPcm(samples: Float32Array): void;
    finish(): void | Promise<void>;
    reset(): void | Promise<void>;
    close(): void;
}
export declare class AsrEngine {
    private readonly recognizer;
    constructor(recognizer: RecognizerLike);
    createSession(sessionId: string, generation: number, emit: (event: AsrResultEvent) => void): AsrSession;
}
//# sourceMappingURL=asr-engine.d.ts.map