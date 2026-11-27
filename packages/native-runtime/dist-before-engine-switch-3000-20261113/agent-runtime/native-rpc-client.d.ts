import { type NativeJsonPacket, type NativeStdioCommand } from "./native-stdio-channel.js";
import { RuntimeSessionError } from "./types.js";
export interface NativeRpcConnection {
    request(method: string, params: NativeJsonPacket, timeoutMs?: number): Promise<NativeJsonPacket>;
    notify(method: string, params: NativeJsonPacket): Promise<void>;
    onNotification(listener: (method: string, params: NativeJsonPacket) => void): () => void;
    onRequest(handler: (method: string, params: NativeJsonPacket) => Promise<unknown>): void;
    onFailure(listener: (error: RuntimeSessionError) => void): () => void;
    dispose(): Promise<void>;
}
export declare function nativeRecord(value: unknown): NativeJsonPacket;
/** Preserve native error identity so clients can recover specific protocol failures. */
export declare class NativeRpcError extends RuntimeSessionError {
    readonly nativeCode?: string | number | undefined;
    constructor(message: string, nativeCode?: string | number | undefined);
}
/** JSON-RPC envelopes only; session, permission and model semantics belong to each client. */
export declare class NativeRpcClient implements NativeRpcConnection {
    private readonly command;
    private readonly jsonrpc;
    private channel;
    private recovery;
    private readonly notifications;
    private readonly failures;
    private requestHandler;
    private disposed;
    constructor(command: () => Promise<NativeStdioCommand>, jsonrpc?: boolean);
    private envelope;
    private connection;
    request(method: string, params: NativeJsonPacket, timeoutMs?: number): Promise<NativeJsonPacket>;
    notify(method: string, params: NativeJsonPacket): Promise<void>;
    onNotification(listener: (method: string, params: NativeJsonPacket) => void): () => void;
    onRequest(handler: (method: string, params: NativeJsonPacket) => Promise<unknown>): void;
    onFailure(listener: (error: RuntimeSessionError) => void): () => void;
    dispose(): Promise<void>;
}
//# sourceMappingURL=native-rpc-client.d.ts.map