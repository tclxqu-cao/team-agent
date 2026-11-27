/** A borrowed connection: this endpoint never grants ownership of a process. */
export interface CodexDesktopEndpoint {
    webSocketUrl: string;
}
export type CodexDesktopEndpointResolver = () => Promise<CodexDesktopEndpoint | null>;
type DiscoveryExecutor = (command: string, args: string[], options: {
    encoding: "utf8";
    timeout: number;
    maxBuffer: number;
}) => Promise<{
    stdout: string;
}>;
export declare function discoverCodexDesktopEndpoint(options?: {
    environment?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    execute?: DiscoveryExecutor;
    homeDir?: string;
}): Promise<CodexDesktopEndpoint | null>;
export {};
//# sourceMappingURL=codex-desktop-endpoint.d.ts.map