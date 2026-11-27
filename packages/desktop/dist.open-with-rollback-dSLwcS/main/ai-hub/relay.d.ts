import { AI_HUB_RELAY_SOCKET_NAME, MAX_RELAY_IMAGES, MAX_RELAY_IMAGE_LENGTH, MAX_RELAY_SITES, MAX_RELAY_TEXT_LENGTH } from "@agent/core";
import type { AIHubManager } from "./manager.js";
export { AI_HUB_RELAY_SOCKET_NAME, MAX_RELAY_IMAGES, MAX_RELAY_IMAGE_LENGTH, MAX_RELAY_SITES, MAX_RELAY_TEXT_LENGTH };
export type AiHubRelayRequest = {
    kind: "status";
} | {
    kind: "broadcast";
    text: string;
    siteIds: string[];
    images: string[];
    background: boolean;
    conversationId?: string;
} | {
    kind: "capture";
    siteIds: string[];
    conversationId?: string;
} | {
    kind: "continue";
    siteIds: string[];
    conversationId?: string;
};
export declare function normalizeRelayImages(raw: unknown): string[];
export declare function parseRelayMessage(line: string): AiHubRelayRequest | null;
export declare function relaySocketPath(directory?: string): string;
export interface AiHubRelay {
    readonly socketPath: string;
    close(): void;
}
export declare function startAiHubRelay(manager: AIHubManager, directory?: string): Promise<AiHubRelay>;
//# sourceMappingURL=relay.d.ts.map