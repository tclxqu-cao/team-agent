import type { BrowserLivePeer, BrowserLiveSessionView } from "./entities.js";
export interface PublishBrowserSession {
    sessionId: unknown;
    backend: unknown;
    browserSessionId?: unknown;
    agentSessionId?: unknown;
    title?: unknown;
    url?: unknown;
    viewport?: unknown;
    transport?: unknown;
    state?: unknown;
    availability?: unknown;
    capabilityError?: unknown;
    capabilityErrorCode?: unknown;
}
export declare class BrowserLiveRegistry {
    private readonly now;
    private readonly sessions;
    private readonly peers;
    constructor(now?: () => number);
    connect(peer: BrowserLivePeer): void;
    list(peer: BrowserLivePeer): BrowserLiveSessionView[];
    publish(peer: BrowserLivePeer, input: PublishBrowserSession): BrowserLiveSessionView;
    updateFrame(peer: BrowserLivePeer, input: Record<string, unknown>): {
        accepted: true;
        sequence: number;
    };
    watch(peer: BrowserLivePeer, sessionId: unknown): BrowserLiveSessionView;
    unwatch(peer: BrowserLivePeer): {
        unwatched: boolean;
    };
    takeOver(peer: BrowserLivePeer, sessionId: unknown): BrowserLiveSessionView;
    returnControl(peer: BrowserLivePeer, sessionId: unknown): BrowserLiveSessionView;
    input(peer: BrowserLivePeer, sessionId: unknown, rawInput: unknown): void;
    producerState(peer: BrowserLivePeer, sessionId: unknown, state: unknown): BrowserLiveSessionView;
    close(peer: BrowserLivePeer, sessionId: unknown): void;
    disconnect(peer: BrowserLivePeer): void;
    private announce;
    private releaseController;
    private requireVisible;
    private requireProducer;
}
//# sourceMappingURL=BrowserLiveRegistry.d.ts.map