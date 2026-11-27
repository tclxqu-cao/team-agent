import { type HarnessEndpointResolver } from "./deepseek-harness-endpoint.js";
export type HarnessRecord = Record<string, unknown>;
export declare function harnessRecord(value: unknown): HarnessRecord;
export interface HarnessStream {
    values: AsyncIterable<HarnessRecord>;
    close(): void;
}
export interface HarnessConnection {
    request(method: string, args: HarnessRecord): Promise<unknown>;
    follow(request: HarnessRecord): Promise<HarnessStream>;
    open?(endpoint: string, args: HarnessRecord): Promise<HarnessStream>;
    dispose(): Promise<void>;
}
/** Borrows an existing native Host before starting an owned dsh web profile. */
export declare class DeepSeekHarnessClient implements HarnessConnection {
    private readonly options;
    private child;
    private connection;
    private connectionRefreshAt;
    private readonly streams;
    constructor(options?: {
        executable?: string;
        url?: string;
        env?: NodeJS.ProcessEnv;
        discoverEndpoint?: HarnessEndpointResolver;
    });
    private connect;
    private start;
    request(method: string, args: HarnessRecord): Promise<unknown>;
    follow(request: HarnessRecord): Promise<HarnessStream>;
    open(endpoint: string, args: HarnessRecord): Promise<HarnessStream>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=deepseek-harness-client.d.ts.map