import type { AsrResultEvent, AsrSession } from "./asr-engine.js";
import type { KwsResultEvent, KwsSession } from "./kws-engine.js";
export interface AsrEngineLike {
    createSession(sessionId: string, generation: number, emit: (event: AsrResultEvent) => void): AsrSession;
}
export interface KwsEngineLike {
    createSession(sessionId: string, generation: number, emit: (event: KwsResultEvent) => void): KwsSession;
}
export interface VoiceServer {
    httpUrl: string;
    wsUrl: string;
    close(): Promise<void>;
}
interface VoiceServerOptions {
    provider?: "local" | "azure";
    host: string;
    port: number;
    token: string | null;
    asrEngine: AsrEngineLike;
    kwsEngine?: KwsEngineLike;
}
export declare function createVoiceServer(options: VoiceServerOptions): Promise<VoiceServer>;
export {};
//# sourceMappingURL=server.d.ts.map