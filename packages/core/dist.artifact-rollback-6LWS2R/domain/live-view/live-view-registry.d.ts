import type { LiveViewAvailability, LiveViewPeer, LiveViewSessionView } from "./entities.js";
import { type RemoteDirectPointer, type RemoteInputContext } from './remote-direct-input.js';
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
    /** Pointer releases return hit tests; committed text waits for dispatch so
     *  a paste failure can be retried without losing the local text. */
    input(peer: LiveViewPeer, sessionId: unknown, rawInput: unknown): Promise<Record<string, unknown> | null>;
    private dispatchInput;
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
    /** The producer binds a transport stream to the currently authenticated control lease. */
    enableDirectInput(peer: LiveViewPeer, sessionId: unknown, context: RemoteInputContext): boolean;
    directReliableInput(peer: LiveViewPeer, sessionId: unknown, context: RemoteInputContext, message: {
        stream: string;
        sequence: number;
        index: number;
        input: unknown;
    }): Promise<Record<string, unknown> | null>;
    directPointerInput(peer: LiveViewPeer, sessionId: unknown, context: {
        controllerId: string;
        epoch: number;
        stream: string;
    }, message: RemoteDirectPointer): boolean;
    isDirectInputActive(peer: LiveViewPeer, sessionId: unknown, context: {
        controllerId: string;
        epoch: number;
        stream: string;
    }): boolean;
    /** Relays WebRTC signaling from the producer back to the active controller. */
    webrtcFromProducer(peer: LiveViewPeer, sessionId: unknown, data: Record<string, unknown>): {
        delivered: boolean;
    };
    producerState(peer: LiveViewPeer, sessionId: unknown, state: unknown): LiveViewSessionView;
    close(peer: LiveViewPeer, sessionId: unknown): void;
    disconnect(peer: LiveViewPeer): void;
    private announce;
    private releaseController;
    private invalidateDirectInput;
    private requireVisible;
    private requireCaptureAdjustment;
    private requireProducer;
}
//# sourceMappingURL=live-view-registry.d.ts.map