import * as speech from "microsoft-cognitiveservices-speech-sdk";
import type { AsrResultEvent, AsrSession } from "./asr-engine.js";
import type { VoiceServiceConfig } from "./config.js";
export type AzureSpeechOptions = NonNullable<VoiceServiceConfig["azure"]>;
/** Azure expects little-endian PCM16; the public voice protocol uses float32. */
export declare function float32ToPcm16(samples: Float32Array): ArrayBuffer;
export declare class AzureAsrEngine {
    private readonly options;
    private readonly sdk;
    private readonly finishTimeoutMs;
    constructor(options: AzureSpeechOptions, sdk?: typeof speech, finishTimeoutMs?: number);
    createSession(sessionId: string, generation: number, emit: (event: AsrResultEvent) => void): AsrSession;
}
//# sourceMappingURL=azure-asr-engine.d.ts.map