import type { AgentEvent } from "@agent/core";
import { type HarnessConnection, type HarnessRecord } from "./deepseek-harness-client.js";
import { type RuntimeQuestionAnswer } from "./types.js";
/** Owns Harness's question waterfall and durable late replies; UI and broker never decide its policy. */
export declare class HarnessInteractions {
    private readonly client;
    private opening;
    private stream;
    private disposed;
    private readonly live;
    private readonly continued;
    private readonly visible;
    private readonly listeners;
    constructor(client: HarnessConnection);
    start(): Promise<void>;
    private connect;
    private pump;
    subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
    events(sessionId: string, projections: HarnessRecord): AgentEvent[];
    answer(questionId: string, answer: RuntimeQuestionAnswer, readProjections: (id: string) => Promise<HarnessRecord>): Promise<boolean>;
    private ref;
    private resolve;
    private emit;
    dispose(): void;
}
//# sourceMappingURL=deepseek-harness-interactions.d.ts.map