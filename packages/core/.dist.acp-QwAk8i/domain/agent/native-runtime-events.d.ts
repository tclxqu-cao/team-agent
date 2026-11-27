import type { AgentEvent, ReasoningSummarySection, RuntimeProgress } from "./entities.js";
export declare function mergeReasoningSummaryDelta(sections: ReasoningSummarySection[] | undefined, event: Extract<AgentEvent, {
    type: "reasoning_summary_delta";
}>): ReasoningSummarySection[];
export declare function reduceRuntimeProgress(events: AgentEvent[]): RuntimeProgress[];
//# sourceMappingURL=native-runtime-events.d.ts.map