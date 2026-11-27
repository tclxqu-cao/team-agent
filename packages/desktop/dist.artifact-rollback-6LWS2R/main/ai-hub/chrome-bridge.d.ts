import { type ChromeHubConversation, type ChromeHubFrame, type ChromeHubStatus } from "./chrome-bridge-protocol.js";
export type ChromeBridgeEvent = {
    type: "chrome-status";
    status: ChromeHubStatus;
} | {
    type: "chrome-conversation";
    conversation: ChromeHubConversation;
} | {
    type: "chrome-page-error";
    siteId: string;
    error: string;
} | {
    type: "chrome-frame";
    frame: ChromeHubFrame;
};
/** Only the local extension with the pairing secret can control explicitly attached provider tabs. */
export declare class ChromeHubBridge {
    private readonly statePath;
    private server;
    private peer;
    private port;
    private readonly token;
    private readonly tabs;
    private readonly frames;
    private readonly conversations;
    private compatible;
    private paused;
    private autoConnectControl;
    private readonly pending;
    private nextId;
    private readonly listeners;
    constructor(statePath: string);
    start(port?: number): Promise<void>;
    pairingCode(): string;
    status(): ChromeHubStatus;
    conversation(siteId: string): ChromeHubConversation | null;
    frame(siteId: string): ChromeHubFrame | null;
    subscribe(listener: (event: ChromeBridgeEvent) => void): () => void;
    private emit;
    private emitStatus;
    private receive;
    request(siteId: string, command: string, payload?: Record<string, unknown>): Promise<unknown>;
    resume(): Promise<ChromeHubStatus>;
    private dispatch;
    private disconnect;
    close(): void;
}
//# sourceMappingURL=chrome-bridge.d.ts.map