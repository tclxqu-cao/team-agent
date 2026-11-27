import { type HarnessConnection } from "./deepseek-harness-client.js";
import type { RuntimeBackgroundJob, RuntimeBackgroundJobOutput, RuntimeBackgroundJobStopResult } from "./background-jobs.js";
/** Reads observer snapshots; the model's consuming job_output cursor is untouched. */
export declare class HarnessJobControl {
    private readonly client;
    private readonly sessionId;
    constructor(client: HarnessConnection, sessionId: string);
    private open;
    private visible;
    private rows;
    private find;
    list(): Promise<RuntimeBackgroundJob[]>;
    output(jobId: string): Promise<RuntimeBackgroundJobOutput>;
    stop(jobId: string): Promise<RuntimeBackgroundJobStopResult>;
}
//# sourceMappingURL=deepseek-harness-job-control.d.ts.map