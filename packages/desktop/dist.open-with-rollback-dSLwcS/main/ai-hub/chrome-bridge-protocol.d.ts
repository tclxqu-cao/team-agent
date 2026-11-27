export declare const CHROME_HUB_SITES: readonly ["chatgpt", "gemini", "grok"];
export type ChromeHubSiteId = typeof CHROME_HUB_SITES[number];
export declare const CHROME_HUB_ORIGINS: Record<ChromeHubSiteId, string>;
export declare function isChromeHubSite(value: string): value is ChromeHubSiteId;
export declare function chromeHubSiteForUrl(value: string): ChromeHubSiteId | null;
export interface ChromeHubTab {
    siteId: ChromeHubSiteId;
    tabId: number;
    url: string;
}
export interface ChromeHubStatus {
    compatible?: boolean;
    paused?: boolean;
    connected: boolean;
    tabs: ChromeHubTab[];
}
export interface ChromeHubFrame {
    siteId: ChromeHubSiteId;
    data: string;
    width: number;
    height: number;
}
export type ChromeHubInput = {
    kind: "pointer";
    action: "down" | "up" | "move" | "wheel";
    x: number;
    y: number;
    deltaX?: number;
    deltaY?: number;
    button?: "left" | "right" | "middle";
} | {
    kind: "key";
    action: "down" | "up";
    key: string;
    code: string;
    modifiers: number;
} | {
    kind: "text";
    text: string;
};
export declare function validChromeHubInput(input: unknown): input is ChromeHubInput;
export interface ChromeHubMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
}
export interface ChromeHubConversation {
    siteId: ChromeHubSiteId;
    conversationId: string;
    revision: number;
    messages: ChromeHubMessage[];
    generating: boolean;
    composerAvailable: boolean;
    receivedAt: number;
}
export declare function validChromeConversation(value: unknown): boolean;
export declare function chromeHubErrorMessage(reason: string): string;
//# sourceMappingURL=chrome-bridge-protocol.d.ts.map