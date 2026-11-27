declare const COMMAND_OPTIONS: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
};
/** Borrowing an endpoint does not transfer process ownership to AgentRoam. */
export interface HarnessEndpoint {
    origin: string;
    cookie: string;
    refreshAt?: number;
}
export type HarnessEndpointResolver = () => Promise<HarnessEndpoint | null>;
type DiscoveryExecutor = (command: string, args: string[], options: typeof COMMAND_OPTIONS) => Promise<{
    stdout: string;
}>;
interface HarnessProcess {
    pid: number;
    kind: "desktop" | "web";
}
export declare function selectHarnessProcesses(stdout: string, uid: number): HarnessProcess[];
export declare function selectHarnessListenerOrigins(stdout: string, pid: number): string[];
/** Current-user process discovery stays in infrastructure; no filesystem or OS facts reach domain/UI code. */
export declare function discoverHarnessEndpoint(options?: {
    desktopOnly?: boolean;
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    uid?: number;
    execute?: DiscoveryExecutor;
    readCookie?: (origin: string) => Promise<string | null>;
    request?: typeof fetch;
}): Promise<HarnessEndpoint | null>;
export {};
//# sourceMappingURL=deepseek-harness-endpoint.d.ts.map