export type VoiceCaptureAction = "start" | "append" | "ignore";
export declare function getVoiceCaptureAction(capturing: boolean, conversation: boolean): VoiceCaptureAction;
export declare function isWakeMatch(heard: string, variants: readonly string[], isFinal: boolean): boolean;
export declare function getWakeCommandSuffix(heard: string, variants: readonly string[]): string | null;
export declare function replaceWakeCommandSuffix(_current: string, suffix: string): string;
export declare function shouldRestartWakeListener(desired: boolean, suspended: boolean): boolean;
export declare function shouldRearmIgnoredWakeKeyword(windowVisible: boolean, wakeDesired: boolean): boolean;
export declare function shouldInvalidateVoiceProvider<T extends object>(active: T | null, failed: T): boolean;
export declare function getVoiceCaptureSilenceTimeout(commandText: string): number;
export declare function shouldRearmWakeOnlyCapture(capturing: boolean, isFinal: boolean, commandText: string): boolean;
export declare function shouldFinalizeVoiceCapture(capturing: boolean, isFinal: boolean, commandText: string): boolean;
export declare function parseWakeTranscriptLine(line: string): {
    heard: string;
    isFinal: boolean;
} | null;
export declare function parseWakeControlLine(line: string): "barge-in" | null;
export declare function routeVoiceServiceResult(current: {
    sessionId: string;
    generation: number;
    lastFinalUtteranceId: number;
}, event: {
    type: "keyword" | "partial" | "final";
    sessionId: string;
    generation: number;
    utteranceId?: number;
}): {
    action: "ignore" | "keyword" | "partial" | "final";
    lastFinalUtteranceId: number;
};
//# sourceMappingURL=voice-capture-state.d.ts.map