export type VoiceMode = "wake" | "dictation" | "barge-in";
export interface AsrStartControl {
    type: "start";
    sessionId: string;
    generation: number;
    sampleRate: 16_000;
    mode: VoiceMode;
    wakeWord?: string;
}
export interface AsrSimpleControl {
    type: "reset" | "finish" | "stop";
    sessionId: string;
    generation: number;
}
export type AsrControl = AsrStartControl | AsrSimpleControl;
export declare function parseAsrControl(raw: string): AsrControl;
//# sourceMappingURL=protocol.d.ts.map