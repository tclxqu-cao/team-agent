import { type ComputerRuntimePort } from "@agent/computer-use";
export interface ComputerRelayServerOptions {
    runtime: ComputerRuntimePort;
    socketPath?: string;
}
export declare class ComputerRelayServer {
    private readonly options;
    readonly socketPath: string;
    private server;
    private readonly sockets;
    constructor(options: ComputerRelayServerOptions);
    start(): Promise<void>;
    close(): Promise<void>;
    private handleSocket;
    private handleLine;
    private write;
}
//# sourceMappingURL=computer-relay-server.d.ts.map