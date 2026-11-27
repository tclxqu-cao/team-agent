import type { TunnelStatus } from "../../server/lib/tunnel-control.mjs";
export interface ServiceDescriptor {
    protocol: 1;
    instanceId: string;
    pid: number;
    url: string;
    dataDir: string;
    token: string;
}
export type ServiceChoice = Pick<ServiceDescriptor, "instanceId" | "url" | "dataDir">;
export type StreamFrame = {
    id: string;
    type: "open" | "data" | "end" | "error";
    data?: string;
};
export type TerminalSocketFrame = {
    type: "open";
} | {
    type: "data";
    data: string | Uint8Array;
} | {
    type: "close";
    code: number;
};
export interface NotificationReadScope {
    serviceId: string;
    ownerId: string;
}
export declare function isTerminalSocketInput(data: unknown): data is string | Uint8Array;
export declare function validDescriptor(value: unknown): value is ServiceDescriptor;
export declare function serviceApiUrl(origin: string, path: unknown): string;
/** No business storage and no child process ownership: this is only a client. */
export declare class SharedServiceConnection {
    private readonly selectionPath;
    private readonly registry;
    private readonly request;
    private selected;
    private preferredDataDir;
    private readonly streams;
    private readonly terminalSockets;
    constructor(selectionPath: string, registry?: string, request?: typeof fetch);
    initialize(): Promise<void>;
    private verify;
    private discover;
    status(): Promise<{
        connected: boolean;
        selected: ServiceChoice | null;
        choices: ServiceChoice[];
        preferredDataDir: string | null;
    }>;
    select(instanceId: string): Promise<ServiceChoice>;
    json(path: string, method: string, body?: string): Promise<{
        status: number;
        body: string;
    }>;
    /** Scope verification and acknowledgement must use one captured credential.
     * Selecting another service while the check is in flight cannot redirect a write. */
    readNotification(id: string, expected: NotificationReadScope): Promise<{
        ok: true;
    }>;
    mobilePairing(): Promise<import("./mobile-pairing.js").MobilePairingInvitation>;
    tunnelStatus(): Promise<TunnelStatus>;
    connectTunnel(): Promise<TunnelStatus>;
    private tunnelRequest;
    stream(id: string, path: string, lastEventId: string, send: (frame: StreamFrame) => void): Promise<void>;
    openTerminal(id: string, send: (frame: TerminalSocketFrame) => void): Promise<void>;
    sendTerminal(id: string, data: unknown): void;
    stop(id: string): void;
    closeStreams(): void;
    private connection;
}
//# sourceMappingURL=shared-service.d.ts.map