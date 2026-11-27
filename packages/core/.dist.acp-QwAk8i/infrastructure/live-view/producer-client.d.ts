interface LiveSocket {
    readonly readyState: number;
    readonly bufferedAmount: number;
    send(data: string | Buffer | Uint8Array): void;
    close(): void;
    on(event: "message", cb: (raw: Buffer) => void): void;
    on(event: "close" | "error", cb: () => void): void;
    once(event: "open", cb: () => void): void;
    once(event: "error", cb: (error: Error) => void): void;
}
type WebSocketFactory = (new (url: string, options: {
    headers: Record<string, string>;
}) => LiveSocket) & {
    OPEN: number;
};
interface FetchResponse {
    ok: boolean;
    status: number;
    json(): Promise<Record<string, unknown>>;
}
export interface PublishLiveSessionMetadata {
    sessionId: string;
    [key: string]: unknown;
}
/** Infrastructure client used inside producer runtimes to publish live frames over the authenticated `/ws`. */
export declare class LiveViewProducerClient {
    #private;
    private readonly endpoint;
    private readonly fetchImpl;
    private readonly WebSocketImpl;
    private readonly timeoutMs;
    private socket;
    private sequence;
    private readonly pending;
    private readonly listeners;
    private readonly channels;
    private readonly metadata;
    private closePromise;
    private resolveClose;
    private readonly sessionClosePromises;
    constructor({ endpoint, fetchImpl, WebSocketImpl, timeoutMs }: {
        endpoint: string;
        fetchImpl?: (url: string | URL, init?: {
            cache?: string;
            headers?: Record<string, string>;
            redirect?: "error";
        }) => Promise<FetchResponse>;
        WebSocketImpl?: WebSocketFactory;
        timeoutMs?: number;
    });
    connect(): Promise<void>;
    onEvent(listener: (event: Record<string, unknown>) => void): () => void;
    publish(metadata: PublishLiveSessionMetadata): Promise<{
        channelId: number;
    }>;
    frame(sessionId: string, frame: {
        sequence: number;
        data: Uint8Array | string;
        title?: string;
        url?: string;
        viewport?: unknown;
    }): Promise<{
        accepted: boolean;
        dropped?: string;
    }>;
    state(sessionId: string, state: string): Promise<unknown>;
    inputResult(sessionId: string, token: number, result: unknown): Promise<unknown>;
    webrtcRelay(sessionId: string, data: Record<string, unknown>): Promise<unknown>;
    unavailable(sessionId: string, error: unknown): Promise<unknown>;
    waitForDisconnect(): Promise<void>;
    close(sessionId: string): Promise<unknown>;
    rpc(type: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
    disconnect(): void;
}
export {};
//# sourceMappingURL=producer-client.d.ts.map