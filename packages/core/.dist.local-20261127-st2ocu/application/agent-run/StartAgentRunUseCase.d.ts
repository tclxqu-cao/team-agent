import type { AgentDefinition } from "../../domain/agent/entities.js";
import type { ISessionStore } from "../../domain/session/entities.js";
import type { SkillDefinition } from "../../domain/skill/entities.js";
import type { ToolExecutionPolicy } from "../../domain/tool/execution-policy.js";
export type AgentRunSource = "desktop" | "webapp" | "sdk" | "portfolio" | "flow-studio";
export interface AgentRunCapabilitySelection {
    enabledTools?: string[];
    enabledSkills?: string[];
    activatedSkills?: string[];
    enabledMCPServers?: string[];
    memoryEnabled?: boolean;
    toolPolicyId?: string;
}
export interface StartAgentRunCommand {
    message: string;
    sessionId?: string;
    agentId?: string;
    skillName?: string;
    modelProfileId?: string;
    images?: string[];
    context?: Record<string, unknown>;
    capabilities?: AgentRunCapabilitySelection;
    session?: {
        projectId?: string;
        title?: string;
        metadata?: Record<string, unknown>;
    };
    source: AgentRunSource;
}
export interface ValidatedAgentRun {
    message: string;
    sessionId: string;
    agent: AgentDefinition | null;
    skill: SkillDefinition | null;
    modelProfileId?: string;
    images?: string[];
    context: Record<string, unknown>;
    capabilities: AgentRunCapabilitySelection;
    toolExecutionPolicy?: ToolExecutionPolicy;
    source: AgentRunSource;
}
export interface StartedAgentRun {
    sessionId: string;
    runId: string;
    streamRef: string;
}
export interface AgentRunCatalog {
    getAgent(id: string): Promise<AgentDefinition | null>;
    getSkill(name: string): Promise<SkillDefinition | null>;
    hasModelProfile(id: string): Promise<boolean> | boolean;
    getToolExecutionPolicy?(id: string): Promise<ToolExecutionPolicy | null> | ToolExecutionPolicy | null;
}
export interface AgentRunRuntime {
    assertAvailable?(sessionId: string): Promise<void> | void;
    start(command: ValidatedAgentRun): Promise<StartedAgentRun> | StartedAgentRun;
}
export type AgentRunErrorCode = "INVALID_RUN_REQUEST" | "AGENT_NOT_FOUND" | "SKILL_NOT_FOUND" | "MODEL_PROFILE_NOT_FOUND" | "SKILL_NOT_ALLOWED" | "TOOL_POLICY_NOT_FOUND" | "TOOL_POLICY_DISABLED";
export declare class AgentRunError extends Error {
    readonly code: AgentRunErrorCode;
    constructor(code: AgentRunErrorCode, message: string);
}
export declare class StartAgentRunUseCase {
    private readonly sessions;
    private readonly catalog;
    private readonly runtime;
    private readonly createId;
    private readonly now;
    constructor(sessions: ISessionStore, catalog: AgentRunCatalog, runtime: AgentRunRuntime, createId?: () => string, now?: () => string);
    execute(raw: StartAgentRunCommand): Promise<StartedAgentRun>;
    private normalize;
}
//# sourceMappingURL=StartAgentRunUseCase.d.ts.map