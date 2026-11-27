import type { AgentConfig, IAgentLoop } from '../domain/agent/entities.js';
import type { IModelProvider } from '../domain/model/entities.js';
import type { IMemoryStore } from '../domain/memory/entities.js';
import type { IContextLoader } from '../domain/context/entities.js';
import type { ITool, IToolExecutor } from '../domain/tool/entities.js';
import { type ToolPermissionGate } from '../domain/tool/permissions.js';
import type { ToolExecutionPolicy } from '../domain/tool/execution-policy.js';
import type { ISessionStore } from '../domain/session/entities.js';
import { ToolRegistry } from '../domain/tool/ToolRegistry.js';
import { SkillRegistry } from '../domain/skill/SkillRegistry.js';
import { ModelRegistry } from './ModelRegistry.js';
import type { RemoteToolStore } from '../domain/remote-tools/RemoteToolStore.js';
export declare class AgentBuilder {
    private workingDirectory;
    private diagnosticObserver;
    withDiagnosticObserver(observer: AgentConfig["diagnosticObserver"]): this;
    private runCheckpointStore;
    withRunCheckpointStore(store: import('../domain/agent/run-checkpoint.js').IRunCheckpointStore): this;
    private modelProvider;
    private modelRegistry;
    private toolRegistry;
    private customTools;
    private skillLoader;
    private skillRegistry;
    private contextLoader;
    private memoryStore;
    private maxIterations;
    private maxTokens;
    private maxOutputTokens;
    private systemPrompt;
    private skillsDir;
    private skillFiles;
    private pluginsDir;
    private sessionStore;
    private remoteToolStore;
    private projectId;
    private compactThreshold;
    /** If set, only these tool names are registered (others are skipped). Empty = all tools. */
    private enabledTools;
    /** Legacy sessions admit tools registered after build; exact policies do not. */
    private allowUnlistedDynamicTools;
    /** If set, only these skill names are registered (others are skipped). Empty = all skills. */
    private enabledSkills;
    /** Skills that must be active in the next built loop. */
    private activatedSkills;
    /** Use the model to find a skill when local triggers do not match. */
    private semanticSkillMatching;
    private skillDiscoveryEnabled;
    /** Reasoning intensity for main-loop requests. undefined/"off" = provider default. */
    private reasoningEffort;
    private toolPermissionGate;
    private toolExecutionPolicy;
    /** Last-mile decorator applied to the composed executor (after the permission gate). */
    private toolExecutorDecorator;
    withWorkingDirectory(path: string): this;
    withModelProvider(provider: IModelProvider): this;
    withModel(providerId: string, config: {
        apiKey: string;
        baseUrl?: string;
        modelId: string;
        timeoutMs?: number;
    }): this;
    withMaxIterations(n: number): this;
    withMaxTokens(n: number): this;
    withMaxOutputTokens(n: number | undefined): this;
    withSystemPrompt(prompt: string | undefined): this;
    withSkillsDirectory(dir: string): this;
    /**
     * Import a skill from a specific SKILL.md file or skill directory.
     * The skill is loaded at build() time and registered with source='custom'.
     * Can be called multiple times to import multiple skills.
     */
    withSkillFile(filePath: string): this;
    withPluginsDirectory(dir: string): this;
    withMemoryStore(store: IMemoryStore): this;
    withContextLoader(loader: IContextLoader): this;
    withSessionStore(store: ISessionStore): this;
    withRemoteToolStore(store: RemoteToolStore, projectId?: string): this;
    withTool(tool: ITool): this;
    private createToolRegistry;
    private systemPromptWithRemoteTools;
    /**
     * Set the AutoCompact threshold as a fraction of maxTokens (default 0.6).
     * When estimated token usage exceeds this fraction, history is summarized.
     */
    withCompactThreshold(fraction: number): this;
    /**
     * Restrict which built-in tools are available. Pass an empty array to re-enable all tools.
     * Takes effect on the next buildSync() call.
     */
    withEnabledTools(toolNames: string[]): this;
    /** Apply an exact per-run allowlist. null means all; [] means none. */
    withExactEnabledTools(toolNames: string[] | null): this;
    /**
     * Restrict which skills are available. Pass an empty array to re-enable all skills.
     * Takes effect on the next build()/buildSync() call.
     */
    withEnabledSkills(skillNames: string[]): this;
    /** Apply an exact per-run allowlist. null means all; [] means none. */
    withExactEnabledSkills(skillNames: string[] | null): this;
    withActivatedSkills(skillNames: string[]): this;
    withSemanticSkillMatching(enabled: boolean): this;
    /** Disable the broad skill search tool while keeping exact-name skill_load. */
    withSkillDiscovery(enabled: boolean): this;
    withReasoningEffort(effort: import("../domain/model/entities.js").ReasoningEffort): this;
    withToolPermissionGate(gate: ToolPermissionGate): this;
    withToolExecutionPolicy(policy: ToolExecutionPolicy | undefined): this;
    /**
     * Register a decorator applied to the fully composed tool executor
     * (after the permission gate, e.g. for checkpointing or auditing).
     * Multiple decorators compose in registration order.
     */
    withToolExecutorDecorator(decorator: (executor: IToolExecutor) => IToolExecutor): this;
    build(): Promise<IAgentLoop>;
    /** Synchronous build — loads skills from disk */
    buildSync(): IAgentLoop;
    private decorateExecutor;
    private composeToolExecutor;
    getToolRegistry(): ToolRegistry;
    getSkillRegistry(): SkillRegistry;
    getModelRegistry(): ModelRegistry;
}
//# sourceMappingURL=AgentBuilder.d.ts.map