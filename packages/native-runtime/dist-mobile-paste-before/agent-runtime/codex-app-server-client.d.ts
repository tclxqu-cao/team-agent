import { spawn } from "node:child_process";
import { type CodexAppServerLauncher, type CodexAppServerLaunchMode } from "./codex-app-server-launcher.js";
import { type CodexDesktopEndpointResolver } from "./codex-desktop-endpoint.js";
export type RpcId = number | string;
export interface RpcNotification {
    method: string;
    params?: Record<string, unknown>;
}
export interface RpcServerRequest extends RpcNotification {
    id: RpcId;
}
export interface CodexAppServerClientOptions {
    executable?: string;
    requestTimeoutMs?: number;
    spawnProcess?: typeof spawn;
    environment?: NodeJS.ProcessEnv;
    launcher?: CodexAppServerLauncher;
    startupTimeoutMs?: number;
    resolveDesktopEndpoint?: CodexDesktopEndpointResolver;
}
export declare class CodexAppServerClient {
    private readonly requestTimeoutMs;
    private readonly proxyWebSocketHandshakeTimeoutMs;
    private readonly launcher;
    private process;
    private webSocket;
    private activeMode;
    private processReady;
    private startPromise;
    private buffer;
    private nextId;
    private disposed;
    private startGeneration;
    private readonly pending;
    private readonly notificationListeners;
    private readonly exitListeners;
    private serverRequestHandler;
    constructor(options?: CodexAppServerClientOptions);
    get pid(): number | undefined;
    get mode(): CodexAppServerLaunchMode | null;
    onNotification(listener: (message: RpcNotification) => void): () => void;
    onExit(listener: (error: Error) => void): () => void;
    setServerRequestHandler(handler: ((message: RpcServerRequest) => void) | null): void;
    request<T>(method: string, params: unknown): Promise<T>;
    respond(id: RpcId, result: unknown): void;
    respondError(id: RpcId, code: number, message: string): void;
    restart(): Promise<void>;
    dispose(): Promise<void>;
    private ensureStarted;
    private start;
    private assertStartCurrent;
    private attachProcess;
    private attachWebSocket;
    private sendRequest;
    private write;
    private handleStdout;
    private handleLine;
    private handleExit;
    private handleTransportExit;
    private stop;
    private stopTransport;
    private rejectPending;
    private detachWebSocket;
}
/**
 * Codex uses Rust's proxy implementation, whose NO_PROXY parser does not
 * consistently treat shell-style host globs such as `*.example.com` as a
 * domain suffix. Keep the original rules for other consumers, but add the
 * equivalent bare and dot-prefixed host rules for the Codex child process.
 */
export declare function normalizeCodexEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
//# sourceMappingURL=codex-app-server-client.d.ts.map