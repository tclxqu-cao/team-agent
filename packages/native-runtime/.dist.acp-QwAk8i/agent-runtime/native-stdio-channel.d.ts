import { RuntimeSessionError } from "./types.js";
export type NativeJsonPacket = Record<string, unknown>;
export interface NativeStdioCommand {
    command: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}
interface Options extends NativeStdioCommand {
    responseKey(packet: NativeJsonPacket): string | undefined;
    onPacket?(packet: NativeJsonPacket): void | Promise<void>;
    onFailure?(error: RuntimeSessionError): void;
    requestTimeoutMs?: number;
    maxLineBytes?: number;
    maxOutputLineBytes?: number;
    maxPendingRequests?: number;
    shutdownGraceMs?: number;
}
/** Bounded NDJSON transport. Protocol-specific envelopes stay in each client. */
export declare class NativeStdioChannel {
    private readonly options;
    private child;
    private startPromise;
    private closePromise;
    private disposePromise;
    private readonly pending;
    private readonly decoder;
    private readonly lineParts;
    private lineBytes;
    private failure;
    private closed;
    constructor(options: Options);
    start(): Promise<void>;
    send(packet: NativeJsonPacket): Promise<void>;
    request(key: string, packet: NativeJsonPacket, timeoutMs?: number): Promise<NativeJsonPacket>;
    dispose(): Promise<void>;
    private get maxLineBytes();
    private consume;
    private finishLine;
    private readPacket;
    private fail;
    private unavailable;
    private protocolError;
}
export {};
//# sourceMappingURL=native-stdio-channel.d.ts.map