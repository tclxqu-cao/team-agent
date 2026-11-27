export interface KeywordStreamLike {
    acceptWaveform(input: {
        samples: Float32Array;
        sampleRate: number;
    }): void;
    inputFinished(): void;
}
export interface KeywordSpotterLike {
    createStream(): KeywordStreamLike;
    isReady(stream: KeywordStreamLike): boolean;
    decode(stream: KeywordStreamLike): void;
    getResult(stream: KeywordStreamLike): {
        keyword: string;
    };
    reset(stream: KeywordStreamLike): void;
}
export type KwsResultEvent = {
    type: "keyword";
    sessionId: string;
    generation: number;
    keyword: string;
};
export interface KwsSession {
    acceptPcm(samples: Float32Array): void;
    reset(): void;
    close(): void;
}
export declare class KwsEngine {
    private readonly spotter;
    constructor(spotter: KeywordSpotterLike);
    createSession(sessionId: string, generation: number, emit: (event: KwsResultEvent) => void): KwsSession;
}
//# sourceMappingURL=kws-engine.d.ts.map