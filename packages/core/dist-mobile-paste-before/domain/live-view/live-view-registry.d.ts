import type { LiveViewAvailability, LiveViewPeer, LiveViewSessionView } from "./entities.js";
export interface PublishLiveSession {
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
    displays?: unknown;
    platform?: unknown;
    audioCapabilities?: unknown;
}
export interface UpdateLiveSessionAvailability {
    availability: LiveViewAvailability;
    capabilityError?: string;
    capabilityErrorCode?: string;
    clearFrame?: boolean;
}
export declare class LiveViewRegistry {
    private readonly now;
    private readonly inputResultTimeoutMs;
    private readonly sessions;
    private readonly peers;
    private inputTokenSequence;
    private readonly pendingInputResults;
    constructor(now?: () => number, inputResultTimeoutMs?: number);
    connect(peer: LiveViewPeer): void;
    list(peer: LiveViewPeer): LiveViewSessionView[];
    publish(peer: LiveViewPeer, input: PublishLiveSession): LiveViewSessionView;
    updateFrame(peer: LiveViewPeer, input: Record<string, unknown>): {
        accepted: true;
        sequence: number;
    };
    updateAvailability(peer: LiveViewPeer, sessionId: unknown, input: UpdateLiveSessionAvailability): LiveViewSessionView;
    watch(peer: LiveViewPeer, sessionId: unknown): LiveViewSessionView;
    unwatch(peer: LiveViewPeer): {
        unwatched: boolean;
    };
    takeOver(peer: LiveViewPeer, sessionId: unknown): LiveViewSessionView;
    returnControl(peer: LiveViewPeer, sessionId: unknown): LiveViewSessionView;
    /** Forwards input to the producer. A pointer release additionally waits
     *  briefly for the producer's dispatch result (the desktop hit-test of the
     *  tapped element); every other input stays on the fire-and-forget path. */
    input(peer: LiveViewPeer, sessionId: unknown, rawInput: unknown): Promise<Record<string, unknown> | null>;
    /** Asks the producer to switch its capture display (multi-display Macs). */
    setDisplay(peer: LiveViewPeer, sessionId: unknown, displayId: unknown): LiveViewSessionView;
    /** Resolves a pending input() reply with the producer's dispatch result. */
    inputResult(peer: LiveViewPeer, sessionId: unknown, token: unknown, result: unknown): {
        delivered: boolean;
    };
    /** Relays WebRTC signaling (offer/answer/ICE) from the controller to the producer. */
    webrtcFromViewer(peer: LiveViewPeer, sessionId: unknown, data: Record<string, unknown>): {
        accepted: boolean;
    };
    /** Relays WebRTC signaling from the producer back to the active controller. */
    webrtcFromProducer(peer: LiveViewPeer, sessionId: unknown, data: Record<string, unknown>): {
        delivered: boolean;
    };
    producerState(peer: LiveViewPeer, sessionId: unknown, state: unknown): LiveViewSessionView;
    close(peer: LiveViewPeer, sessionId: unknown): void;
    disconnect(peer: LiveViewPeer): void;
    private announce;
    private releaseController;
    private requireVisible;
    private requireCaptureAdjustment;
    private requireProducer;
}
//# sourceMappingURL=live-view-registry.d.ts.map