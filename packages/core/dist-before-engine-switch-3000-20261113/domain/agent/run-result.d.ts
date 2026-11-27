import type { AgentEvent, TokenUsage } from './entities.js';
export type RunStatus = "completed" | "failed" | "cancelled" | "interrupted";
export type RunReasonCode = "completed" | "user_cancelled" | "auth_required" | "quota_exceeded" | "rate_limited" | "permission_denied" | "context_limit" | "output_limit" | "timeout" | "network_error" | "runtime_unavailable" | "provider_error" | "runtime_interrupted" | "protocol_error" | "iteration_limit" | "tool_cycle" | "unknown_error";
export interface RunResult {
    status: RunStatus;
    reason: RunReasonCode;
    durationMs: number;
    runId?: string;
    usage?: TokenUsage;
}
export type RunTerminalEvent = Extract<AgentEvent, {
    type: "done" | "error" | "turn_aborted";
}>;
export declare function normalizeTokenUsage(value: unknown): TokenUsage | undefined;
export declare function classifyRunError(message: string, code?: string): Exclude<RunReasonCode, "completed">;
export declare function createRunResult(event: RunTerminalEvent, options: {
    durationMs: number;
    runId?: string;
    cancelled?: boolean;
}): RunResult;
export declare function runResultLabel(result: RunResult): string;
//# sourceMappingURL=run-result.d.ts.map