import type { LiveViewDisplayOption, LiveViewInput, LiveViewOwnershipState, LiveViewSource } from "../../domain/live-view/entities.js";
import type { PublishLiveSessionMetadata } from "./producer-client.js";
/** Port implemented per runtime: continuous frames plus normalized input dispatch. */
export interface LiveScreencastPort {
    start(onFrame: (frame: LiveScreencastFrame) => Promise<{
        accepted?: boolean;
    } | void>): Promise<void>;
    stop(): Promise<void>;
    /** Returns an adapter-defined result (e.g. a hit-test of a tapped element) when available. */
    dispatchInput(input: LiveViewInput): Promise<unknown>;
}
export interface LiveScreencastFrame {
    data: Uint8Array | string;
    viewport: unknown;
    title: string;
    url: string;
    timestamp: number;
}
export interface LiveViewProducerClientPort {
    connect(): Promise<void>;
    onEvent(listener: (event: Record<string, unknown>) => void): () => void;
    publish(metadata: Record<string, unknown>): Promise<unknown>;
    frame(sessionId: string, frame: LiveScreencastFrame & {
        sequence: number;
    }): Promise<{
        accepted?: boolean;
    }>;
    state(sessionId: string, state: LiveViewOwnershipState): Promise<unknown>;
    /** Relays the adapter's input dispatch result back to the requesting viewer. */
    inputResult(sessionId: string, token: number, result: unknown): Promise<unknown>;
    /** Relays WebRTC signaling from the producer to the active viewer. */
    webrtcRelay(sessionId: string, data: Record<string, unknown>): Promise<unknown>;
    /** Re-publishes session metadata (e.g. after the capture display changed). */
    publish(metadata: PublishLiveSessionMetadata): Promise<unknown>;
    unavailable(sessionId: string, error: unknown): Promise<unknown>;
    waitForDisconnect(): Promise<void>;
    close(sessionId: string): Promise<unknown>;
    disconnect(): void;
}
interface ProducerMetadata {
    sessionId: string;
    backend: LiveViewSource;
    [key: string]: unknown;
}
/** Application service coordinating a screencast adapter with the live relay. */
export declare class LiveViewProducer {
    #private;
    private readonly client;
    private readonly screencast;
    readonly metadata: ProducerMetadata;
    private readonly pauseAgent;
    private readonly resyncAgent;
    private frameSequence;
    private unsubscribe;
    private controlState;
    private eventQueue;
    private readonly onPublished;
    private readonly onError;
    private readonly onSetDisplay;
    constructor({ client, screencast, metadata, pauseAgent, resyncAgent, onError, onPublished, onSetDisplay }: {
        client: LiveViewProducerClientPort;
        screencast: LiveScreencastPort;
        metadata: ProducerMetadata;
        pauseAgent: () => Promise<void>;
        resyncAgent: () => Promise<void>;
        onError?: (error: unknown) => void;
        onPublished?: () => void;
        onSetDisplay?: ((displayId: string | null) => Promise<LiveViewDisplayOption[] | null>) | null;
    });
    run(): Promise<void>;
}
export {};
//# sourceMappingURL=producer.d.ts.map