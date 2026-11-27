import type { Message } from "../model/entities.js";
import type { ContextHandoff, EngineSwitchRecord, EngineSwitchSessionView } from "./entities.js";
export declare const HANDOFF_INPUT_SEPARATOR = "\n\n[agentroam:current-user-message]\n";
export interface EngineThreadPhase {
    sessionId: string;
    agentType: EngineSwitchSessionView["agentType"];
    messages: Message[];
    boundaryUncertain?: boolean;
}
/** Remove our own transport envelope; never summarize a summary recursively. */
export declare function cleanEngineHistory(messages: readonly Message[], handoffs: readonly Pick<ContextHandoff, "summaryText">[]): Message[];
/** Ids are opaque. Compare actual message boundaries, falling back to content. */
export declare function historyDeltaStart(current: readonly Message[], previous: readonly Message[]): number;
export declare function scopedHistory(messages: readonly Message[], sessionId: string, start?: number, phase?: string): Message[];
/** Saved phases are immutable. Only the currently active phase reads live history. */
export declare function engineThreadPhases(records: readonly EngineSwitchRecord[], active: EngineSwitchSessionView, legacySources?: ReadonlyMap<string, EngineSwitchSessionView>, handoffs?: readonly ContextHandoff[]): EngineThreadPhase[];
export declare function threadDisplayMessages(phases: readonly EngineThreadPhase[]): Message[];
//# sourceMappingURL=thread-history.d.ts.map