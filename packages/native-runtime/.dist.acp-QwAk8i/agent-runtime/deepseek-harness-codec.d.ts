import type { AgentEvent, Message, ToolCall } from "@agent/core";
import { type HarnessRecord } from "./deepseek-harness-client.js";
export declare function isHarnessContextMessage(message: Message): boolean;
export declare function isHarnessSteeredMessage(message: Message): boolean;
export declare function harnessContent(value: unknown, type?: string): string;
export declare function harnessToolCall(data: HarnessRecord): ToolCall;
export declare function harnessMessage(event: HarnessRecord): Message | null;
/** Replay official surface replacements before projecting the shared chat model. */
export declare function decodeHarnessHistory(records: HarnessRecord[]): {
    messages: Message[];
    events: AgentEvent[];
};
export declare function harnessChunkEvent(frame: HarnessRecord): AgentEvent | null;
//# sourceMappingURL=deepseek-harness-codec.d.ts.map