import type { AiHubCaptureResult, AiHubRelayResult, AiHubSiteInfo, AiHubTransport } from "../domain/ai-hub/transport.js";
export declare function desktopOfflineError(): Error;
interface BroadcastPayload {
    available: boolean;
    reason?: string;
    results: AiHubRelayResult[];
}
interface CapturePayload {
    available: boolean;
    reason?: string;
    results: AiHubCaptureResult[];
}
export declare class AiHubSocketTransport implements AiHubTransport {
    status(): Promise<{
        available: boolean;
        sites?: AiHubSiteInfo[];
    }>;
    broadcast(text: string, siteIds: string[], images?: string[], conversationId?: string): Promise<BroadcastPayload>;
    capture(siteIds: string[], conversationId?: string): Promise<CapturePayload>;
    continueGeneration(siteIds: string[], conversationId?: string): Promise<BroadcastPayload>;
}
export {};
//# sourceMappingURL=AiHubSocketTransport.d.ts.map