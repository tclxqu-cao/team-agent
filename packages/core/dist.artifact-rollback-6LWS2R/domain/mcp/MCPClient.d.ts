import type { IMCPClient, MCPServerConfig, MCPTool, MCPResource } from './entities.js';
export declare class MCPClient implements IMCPClient {
    readonly serverId: string;
    private process;
    private requestId;
    private pendingRequests;
    /** Live request timers — flushed when the transport dies so they never keep the event loop alive. */
    private pendingTimeouts;
    private _connected;
    private config;
    private toolCache;
    private ssePostUrl;
    private sseRes;
    private mcpSessionId;
    constructor(serverId: string);
    /** Reject and clean up every in-flight request (transport died or shutdown). */
    private flushPendingRequests;
    get connected(): boolean;
    connect(config: MCPServerConfig): Promise<void>;
    private connectStdio;
    disconnect(): void;
    listTools(): Promise<MCPTool[]>;
    listResources(): Promise<MCPResource[]>;
    callTool(name: string, args: unknown): Promise<unknown>;
    readResource(uri: string): Promise<unknown>;
    private sendRequest;
    /** Send a JSON-RPC request via HTTP POST to the SSE server's message endpoint. */
    private sendRequestSSE;
    /**
     * Streamable HTTP transport: stateless JSON-RPC over HTTP POST.
     * Each request is an independent POST to the URL with custom headers.
     * Some servers skip the initialize handshake — we attempt it but tolerate 400.
     */
    private connectStreamableHttp;
    /** Send a JSON-RPC request via HTTP POST (streamableHttp transport). */
    private sendRequestHttp;
    /**
     * Connect using SSE transport (MCP over HTTP+SSE).
     * 1. GET {url} with Accept: text/event-stream → receive "endpoint" event with POST path
     * 2. POST JSON-RPC requests to the message endpoint
     * 3. Receive responses via SSE "message" events
     */
    private connectSSE;
}
//# sourceMappingURL=MCPClient.d.ts.map