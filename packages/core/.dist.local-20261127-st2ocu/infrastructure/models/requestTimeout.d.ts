import type { StreamEvent } from "../../domain/model/entities.js";
export declare function isModelRequestTimeout(error: unknown, signal: AbortSignal): boolean;
export declare function modelRequestTimeoutEvent(provider: string, timeoutMs: number): Extract<StreamEvent, {
    type: "error";
}>;
//# sourceMappingURL=requestTimeout.d.ts.map