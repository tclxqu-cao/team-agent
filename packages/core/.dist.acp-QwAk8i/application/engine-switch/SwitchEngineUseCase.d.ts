import type { AgentType } from "../../domain/agent/agent-type.js";
import type { ContextHandoff, EngineSwitchCreatedSession, EngineSwitchRecord, EngineSwitchThread } from "../../domain/engine-switch/entities.js";
import type { EngineSwitchRepository } from "../../domain/engine-switch/EngineSwitchRepository.js";
import type { EngineSwitchRuntime } from "../../domain/engine-switch/EngineSwitchRuntime.js";
export type EngineSwitchErrorCode = "INVALID_SESSION_ID" | "SOURCE_NOT_FOUND" | "TARGET_NOT_NATIVE" | "RUNTIME_UNAVAILABLE" | "SESSION_OCCUPIED" | "STALE_THREAD";
export declare class EngineSwitchError extends Error {
    readonly code: EngineSwitchErrorCode;
    constructor(code: EngineSwitchErrorCode, message: string);
}
export interface SwitchEngineCommand {
    sourceSessionId: string;
    targetAgentType: AgentType;
    /** Logical thread key; defaults to the thread the source session belongs to. */
    threadKey?: string;
    /** Explicitly request a clean target context (force strategy "create"). */
    clean?: boolean;
    /** Handoff budget in tokens. */
    budgetTokens?: number;
}
export interface SwitchEngineResult {
    thread: EngineSwitchThread;
    record: EngineSwitchRecord;
    handoff: ContextHandoff | null;
    targetSession: EngineSwitchCreatedSession;
    strategy: "resume" | "create";
}
export interface SwitchEngineDeps {
    runtime: EngineSwitchRuntime;
    repository: EngineSwitchRepository;
    now?: () => string;
    newId?: () => string;
}
export declare class SwitchEngineUseCase {
    private readonly deps;
    private readonly now;
    private readonly newId;
    constructor(deps: SwitchEngineDeps);
    execute(command: SwitchEngineCommand): Promise<SwitchEngineResult>;
    private assertIdle;
}
//# sourceMappingURL=SwitchEngineUseCase.d.ts.map