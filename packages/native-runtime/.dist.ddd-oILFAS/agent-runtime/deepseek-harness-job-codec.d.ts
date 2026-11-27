import type { AgentEvent } from "@agent/core";
import { type HarnessRecord } from "./deepseek-harness-client.js";
/** Decodes a native output batch into a bounded observer preview. */
export declare function appendHarnessJobOutput(output: string, frame: HarnessRecord): string;
/** Translates native job facts to source-independent runtime progress. */
export declare function harnessJobProgress(job: HarnessRecord, output?: string): Extract<AgentEvent, {
    type: "runtime_progress";
}>;
//# sourceMappingURL=deepseek-harness-job-codec.d.ts.map