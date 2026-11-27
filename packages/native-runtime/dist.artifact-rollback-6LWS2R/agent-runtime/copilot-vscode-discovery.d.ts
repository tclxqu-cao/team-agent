/** Credentials stay inside the infrastructure boundary and are never logged. */
export interface VSCodeAgentEndpoint {
    instanceId: string;
    pid: number;
    endpoint: {
        type: "socket";
        path: string;
    };
    connectionToken: string;
    protocolVersion: string;
}
export declare function vscodeUserDataDirectories(): string[];
/** Read only VS Code's owner-protected local endpoint catalogue; never starts a host. */
export declare function discoverVSCodeAgentEndpoints(directories?: string[], isAlive?: (pid: number) => boolean): Promise<VSCodeAgentEndpoint[]>;
//# sourceMappingURL=copilot-vscode-discovery.d.ts.map