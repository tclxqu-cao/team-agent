import type { AgentConfig, IAgentLoop } from './entities.js';
import type { IModelProvider } from '../model/entities.js';
import type { IMemoryStore } from '../memory/entities.js';
import type { ITool } from '../tool/entities.js';
import { PermissionAwareToolExecutor, type ToolPermissionGate } from '../tool/permissions.js';
import type { ISessionStore } from '../session/entities.js';
import { AgentFactory } from './AgentFactory.js';
import { ToolRegistry } from '../tool/ToolRegistry.js';
import { registerBuiltinTools } from '../tool/builtin/index.js';
import { SkillLoader } from '../skill/SkillLoader.js';
import { SkillRegistry } from '../skill/SkillRegistry.js';
import { ContextLoader } from '../context/ContextLoader.js';
import { ContextAssembler } from '../context/ContextAssembler.js';
import { FileSystemMemoryStore } from '../memory/FileSystemMemoryStore.js';
import { ModelRegistry } from '../model/ModelRegistry.js';
import type { RemoteToolStore } from '../remote-tools/RemoteToolStore.js';
import { describeRemoteTool, RemoteProjectActionTool } from '../tool/builtin/RemoteProjectActionTool.js';

export class AgentBuilder {
  private workingDirectory = process.cwd();
  private modelProvider: IModelProvider | null = null;
  private modelRegistry = new ModelRegistry();
  private toolRegistry = new ToolRegistry();
  private customTools: ITool[] = [];
  private skillLoader = new SkillLoader();
  private skillRegistry = new SkillRegistry(this.skillLoader);
  private contextLoader = new ContextLoader();
  private memoryStore: IMemoryStore | null = null;
  private maxIterations = 10;
  private maxTokens = 100_000;
  private systemPrompt: string | undefined;
  private skillsDir: string | undefined;
  private skillFiles: string[] = [];
  private pluginsDir: string | undefined;
  private sessionStore: ISessionStore | undefined;
  private remoteToolStore: RemoteToolStore | undefined;
  private projectId = process.env.AGENT_PROJECT_ID ?? "default";
  private compactThreshold: number | undefined;
  /** If set, only these tool names are registered (others are skipped). Empty = all tools. */
  private enabledTools: string[] | null = null;
  /** If set, only these skill names are registered (others are skipped). Empty = all skills. */
  private enabledSkills: string[] | null = null;
  /** Use the model to find a skill when local triggers do not match. */
  private semanticSkillMatching = true;
  /** Reasoning intensity for main-loop requests. undefined/"off" = provider default. */
  private reasoningEffort: import("../model/entities.js").ReasoningEffort | undefined;
  private toolPermissionGate: ToolPermissionGate | undefined;

  withWorkingDirectory(path: string): this {
    this.workingDirectory = path;
    return this;
  }

  withModelProvider(provider: IModelProvider): this {
    this.modelProvider = provider;
    this.modelRegistry.register(provider);
    return this;
  }

  withModel(providerId: string, config: {
    apiKey: string;
    baseUrl?: string;
    modelId: string;
  }): this {
    this.modelProvider = this.modelRegistry.createAndRegister(
      providerId as "anthropic" | "openai" | "deepseek",
      config,
    );
    return this;
  }

  withMaxIterations(n: number): this {
    this.maxIterations = n;
    return this;
  }

  withMaxTokens(n: number): this {
    this.maxTokens = n;
    return this;
  }

  withSystemPrompt(prompt: string | undefined): this {
    this.systemPrompt = prompt;
    return this;
  }

  withSkillsDirectory(dir: string): this {
    this.skillsDir = dir;
    return this;
  }

  /**
   * Import a skill from a specific SKILL.md file or skill directory.
   * The skill is loaded at build() time and registered with source='custom'.
   * Can be called multiple times to import multiple skills.
   */
  withSkillFile(filePath: string): this {
    this.skillFiles.push(filePath);
    return this;
  }

  withPluginsDirectory(dir: string): this {
    this.pluginsDir = dir;
    return this;
  }

  withMemoryStore(store: IMemoryStore): this {
    this.memoryStore = store;
    return this;
  }

  withSessionStore(store: ISessionStore): this {
    this.sessionStore = store;
    return this;
  }

  withRemoteToolStore(store: RemoteToolStore, projectId = process.env.AGENT_PROJECT_ID ?? "default"): this {
    this.remoteToolStore = store;
    this.projectId = projectId;
    return this;
  }

  withTool(tool: ITool): this {
    this.customTools = [...this.customTools.filter((existing) => existing.name !== tool.name), tool];
    this.toolRegistry.register(tool);
    return this;
  }

  private createToolRegistry(remoteToolStore: RemoteToolStore | undefined, projectId: string): ToolRegistry {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    for (const tool of this.customTools) registry.register(tool);
    if (remoteToolStore) {
      registry.register(new RemoteProjectActionTool({ store: remoteToolStore, projectId }));
    }
    return registry;
  }

  private systemPromptWithRemoteTools(remoteToolStore: RemoteToolStore | undefined, projectId: string): string | undefined {
    const tools = remoteToolStore?.listEnabledTools(projectId) ?? [];
    if (tools.length === 0) return this.systemPrompt;
    const summary = ["可用远程项目工具：", ...tools.map(describeRemoteTool)].join("\n");
    return [this.systemPrompt, summary].filter(Boolean).join("\n\n");
  }

  /**
   * Set the AutoCompact threshold as a fraction of maxTokens (default 0.8).
   * When estimated token usage exceeds this fraction, history is summarized.
   */
  withCompactThreshold(fraction: number): this {
    this.compactThreshold = fraction;
    return this;
  }

  /**
   * Restrict which built-in tools are available. Pass an empty array to re-enable all tools.
   * Takes effect on the next buildSync() call.
   */
  withEnabledTools(toolNames: string[]): this {
    this.enabledTools = toolNames.length > 0 ? toolNames : null;
    return this;
  }

  /**
   * Restrict which skills are available. Pass an empty array to re-enable all skills.
   * Takes effect on the next build()/buildSync() call.
   */
  withEnabledSkills(skillNames: string[]): this {
    this.enabledSkills = skillNames.length > 0 ? skillNames : null;
    return this;
  }

  withSemanticSkillMatching(enabled: boolean): this {
    this.semanticSkillMatching = enabled;
    return this;
  }

  withReasoningEffort(effort: import("../model/entities.js").ReasoningEffort): this {
    this.reasoningEffort = effort;
    return this;
  }

  withToolPermissionGate(gate: ToolPermissionGate): this {
    this.toolPermissionGate = gate;
    return this;
  }

  async build(): Promise<IAgentLoop> {
    if (!this.modelProvider) {
      throw new Error("Model provider is required. Call withModelProvider() or withModel()");
    }

    const remoteToolStore = this.remoteToolStore;
    const projectId = this.projectId;

    // Wire model provider into skill registry for semantic matching
    this.skillRegistry.setModelProvider(this.modelProvider);
    this.skillRegistry.setSemanticMatchingEnabled(this.semanticSkillMatching);

    // Initialize memory store (use injected or fall back to filesystem)
    const memoryStore = this.memoryStore ?? new FileSystemMemoryStore(this.workingDirectory);

    const toolRegistry = this.createToolRegistry(remoteToolStore, projectId);
    this.toolRegistry = toolRegistry;

    // Load skills from all discovered sources, then optionally add from explicit dir
    const discoveredSkills = await this.skillLoader.loadAll(this.workingDirectory);
    for (const skill of discoveredSkills) {
      this.skillRegistry.register(skill);
    }
    if (this.skillsDir) {
      const extraSkills = await this.skillLoader.loadFromDirectory(this.skillsDir, "custom");
      for (const skill of extraSkills) {
        if (!this.skillRegistry.get(skill.name)) {
          this.skillRegistry.register(skill);
        }
      }
    }

    // Import individual skill files specified via withSkillFile()
    for (const filePath of this.skillFiles) {
      const skill = await this.skillLoader.loadFromFile(filePath);
      if (!this.skillRegistry.get(skill.name)) {
        this.skillRegistry.register({ ...skill, source: "custom" });
      }
    }

    const contextAssembler = new ContextAssembler(this.contextLoader);

    const config: AgentConfig = {
      modelProvider: this.modelProvider,
      toolRegistry,
      toolExecutor: this.toolPermissionGate
        ? new PermissionAwareToolExecutor(toolRegistry, this.toolPermissionGate)
        : toolRegistry,
      contextAssembler,
      skillRegistry: this.skillRegistry,
      memoryStore,
      sessionStore: this.sessionStore,
      workingDirectory: this.workingDirectory,
      maxIterations: this.maxIterations,
      maxTokens: this.maxTokens,
      systemPrompt: this.systemPromptWithRemoteTools(remoteToolStore, projectId),
      compactThreshold: this.compactThreshold,
      enabledTools: this.enabledTools,
      enabledSkills: this.enabledSkills,
      reasoningEffort: this.reasoningEffort,
    };

    return new AgentFactory().create(config);
  }

  /** Synchronous build — loads skills from disk */
  buildSync(): IAgentLoop {
    if (!this.modelProvider) {
      throw new Error("Model provider is required. Call withModelProvider() or withModel()");
    }

    const remoteToolStore = this.remoteToolStore;
    const projectId = this.projectId;

    // Wire model provider into skill registry for semantic matching
    this.skillRegistry.setModelProvider(this.modelProvider);
    this.skillRegistry.setSemanticMatchingEnabled(this.semanticSkillMatching);

    const memoryStore = this.memoryStore ?? new FileSystemMemoryStore(this.workingDirectory);
    const toolRegistry = this.createToolRegistry(remoteToolStore, projectId);
    this.toolRegistry = toolRegistry;

    // Load skills from disk
    const discoveredSkills = this.skillLoader.loadAllSync(this.workingDirectory);
    for (const skill of discoveredSkills) {
      this.skillRegistry.register(skill);
    }
    if (this.skillsDir) {
      const extraSkills = this.skillLoader.loadFromDirectorySync(this.skillsDir, "custom");
      for (const skill of extraSkills) {
        if (!this.skillRegistry.get(skill.name)) {
          this.skillRegistry.register(skill);
        }
      }
    }
    for (const filePath of this.skillFiles) {
      const skill = this.skillLoader.loadFromFileSync(filePath);
      if (!this.skillRegistry.get(skill.name)) {
        this.skillRegistry.register({ ...skill, source: "custom" });
      }
    }

    const contextAssembler = new ContextAssembler(this.contextLoader);

    const config: AgentConfig = {
      modelProvider: this.modelProvider,
      toolRegistry,
      toolExecutor: this.toolPermissionGate
        ? new PermissionAwareToolExecutor(toolRegistry, this.toolPermissionGate)
        : toolRegistry,
      contextAssembler,
      skillRegistry: this.skillRegistry,
      memoryStore,
      sessionStore: this.sessionStore,
      workingDirectory: this.workingDirectory,
      maxIterations: this.maxIterations,
      maxTokens: this.maxTokens,
      systemPrompt: this.systemPromptWithRemoteTools(remoteToolStore, projectId),
      compactThreshold: this.compactThreshold,
      enabledTools: this.enabledTools,
      enabledSkills: this.enabledSkills,
      reasoningEffort: this.reasoningEffort,
    };

    return new AgentFactory().create(config);
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }

  getModelRegistry(): ModelRegistry {
    return this.modelRegistry;
  }
}
