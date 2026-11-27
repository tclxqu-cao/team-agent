import type { AgentEvent } from '../domain/agent/entities.js';
export interface HarnessModelSettings {
    provider: string;
    modelId: string;
    apiKey: string;
    baseUrl?: string;
}
export interface HarnessServiceStatus {
    state: 'starting' | 'waiting-model' | 'ready' | 'repairing' | 'stopped' | 'unavailable';
    pid?: number;
    modelId?: string;
    detail?: string;
    quality?: unknown;
}
export interface HarnessServiceOptions {
    owner: 'desktop' | 'server' | 'tui';
    sourceRoot?: string;
    stateDirectory?: string;
    bunExecutable?: string;
    nodeExecutable?: string;
    enabled?: boolean;
}
/** Source-mode companion: no model request on boot; secrets travel only over the private pipe. */
export declare class HarnessServiceClient {
    private readonly options;
    private child;
    private starting;
    private closed;
    private model;
    private current;
    private restartCount;
    private runtimeVersion;
    private readonly onExit;
    constructor(options: HarnessServiceOptions);
    get status(): HarnessServiceStatus;
    setModel(model: HarnessModelSettings): void;
    start(): Promise<void>;
    private launch;
    private send;
    observe(sessionId: string, observation: unknown): void;
    monitor(events: AsyncIterable<AgentEvent>, task: {
        input: string;
        sessionId: string;
        workingDirectory: string;
    }): AsyncIterable<AgentEvent>;
    withUserWait<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
    close(): void;
}
//# sourceMappingURL=HarnessServiceClient.d.ts.map