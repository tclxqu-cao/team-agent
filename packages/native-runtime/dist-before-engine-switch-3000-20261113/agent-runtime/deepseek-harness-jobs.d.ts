import type { AgentEvent } from "@agent/core";
import { type HarnessConnection } from "./deepseek-harness-client.js";
type ProgressEvent = Extract<AgentEvent, {
    type: "runtime_progress";
}>;
/** Mirrors native job observers without consuming the model's job_output cursor. */
export declare class HarnessJobs {
    private readonly client;
    private readonly sessionId;
    private readonly emit;
    private stopped;
    private readonly streams;
    private readonly watchers;
    private readonly views;
    constructor(client: HarnessConnection, sessionId: string, emit: (event: ProgressEvent) => void);
    private open;
    private reportFailure;
    snapshot(): Promise<ProgressEvent[]>;
    watch(): Promise<void>;
    private follow;
    close(): Promise<void>;
}
export {};
//# sourceMappingURL=deepseek-harness-jobs.d.ts.map