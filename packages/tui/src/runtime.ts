import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { pathToFileURL } from "node:url";
import { HarnessServiceClient } from "../../core/src/infrastructure/HarnessServiceClient.js";
import { AgentBuilder } from "../../core/src/domain/agent/AgentBuilder.js";
import type { AgentEvent, IAgentLoop } from "../../core/src/domain/agent/entities.js";
import type { SessionCompaction } from "../../core/src/domain/agent/entities.js";
import { FileSystemSessionStore } from "../../core/src/domain/session/SessionStore.js";
import type { ISessionStore, Session } from "../../core/src/domain/session/entities.js";
import type { SkillMeta } from "../../core/src/domain/skill/entities.js";
import {
  AskUserTool,
  DispatchAgentTool,
  type AskUserRequest,
  type AskUserResponse,
  type DispatchResult,
} from "../../core/src/domain/tool/builtin/index.js";
import {
  CheckpointAwareToolExecutor,
  InMemoryFileCheckpointJournal,
  type IFileCheckpointJournal,
} from "../../core/src/domain/tool/checkpoints.js";
import { ToolPermissionGate } from "../../core/src/domain/tool/permissions.js";
import { MCPManager } from "../../core/src/domain/mcp/MCPManager.js";
import type { MCPServerConfig } from "../../core/src/domain/mcp/entities.js";
import type { ToolApprovalDecision, ToolPermissionMode, ToolPermissionRequest } from "@agent/core";
import { DEFAULT_PERMISSION_MODE, type McpServerEntry, type ModelSelection } from "./model-config.js";

export interface SessionSummary {
  id: string;
  title: string;
  created: string;
}

export type QuestionHandler = (request: AskUserRequest) => Promise<AskUserResponse>;
export type ApprovalHandler = (request: ToolPermissionRequest) => Promise<ToolApprovalDecision>;

/** Nested sub-agent activity surfaced to the UI while a dispatch runs. */
export interface SubagentActivity {
  agentName: string;
  kind: "tool" | "done";
  name?: string;
}

export type SubagentReporter = (activity: SubagentActivity) => void;

export interface McpStatus {
  id: string;
  connected: boolean;
  tools: string[];
  error?: string;
}

interface McpRuntimeState {
  manager: MCPManager;
  statuses: McpStatus[];
}

/** Composition hooks the agent factory reads while wiring a build. */
export interface TuiRuntimeHost {
  resolvePermissionMode(): ToolPermissionMode;
  requestApproval(request: ToolPermissionRequest): Promise<ToolApprovalDecision>;
  getSessionStore(): ISessionStore;
  getMcpServers(): McpServerEntry[];
  getCheckpointJournal(): IFileCheckpointJournal | null;
  registerMcp(state: McpRuntimeState): void;
  dispatchSubagent(agentName: string, task: string, parentSessionId: string): Promise<DispatchResult>;
  reportSubagentActivity(activity: SubagentActivity): void;
}

export interface RuntimeSnapshot {
  workingDirectory: string;
  model: ModelSelection;
  sessionId: string;
  skills: SkillMeta[];
}

export type AgentBuildResult = { agent: IAgentLoop; skills: SkillMeta[] };
export type AgentFactory = (workingDirectory: string, model: ModelSelection, question: QuestionHandler, host: TuiRuntimeHost) => Promise<AgentBuildResult>;

function toMcpServerConfig(entry: McpServerEntry): MCPServerConfig {
  if (entry.command) {
    return {
      id: entry.id,
      name: entry.name ?? entry.id,
      transport: "stdio",
      command: entry.command,
      args: entry.args,
      env: entry.env,
    };
  }
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    transport: "streamableHttp",
    url: entry.url,
    headers: entry.headers,
  };
}

async function connectMcpEntry(manager: MCPManager, entry: McpServerEntry): Promise<McpStatus> {
  try {
    await manager.connectServer(toMcpServerConfig(entry));
    const tools = (await manager.getClient(entry.id)?.listTools().catch(() => [])) ?? [];
    return { id: entry.id, connected: true, tools: tools.map((tool) => tool.name) };
  } catch (error) {
    return { id: entry.id, connected: false, tools: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export class TuiRuntime implements TuiRuntimeHost {
  private readonly harness = new HarnessServiceClient({ owner: "tui" });
  private agent: IAgentLoop | null = null;
  private skillsCache: SkillMeta[] = [];
  private currentSessionId = "";
  private questionHandler: QuestionHandler = async () => ({ answer: "" });
  private approvalHandler: ApprovalHandler = async () => "deny";
  private permissionMode: ToolPermissionMode = DEFAULT_PERMISSION_MODE;
  /** False only for brand-new sessions so the first user message can name them. */
  private sessionTitled = false;
  private readonly checkpointJournal: IFileCheckpointJournal = new InMemoryFileCheckpointJournal();
  private mcpEntries: McpServerEntry[] = [];
  private mcpState: McpRuntimeState | null = null;
  private dispatchReporter: SubagentReporter = () => {};
  private readonly agentFactory: AgentFactory;

  constructor(
    private workingDirectory: string,
    private model: ModelSelection,
    private readonly storeDir: string,
    private readonly sessionStore: ISessionStore = new FileSystemSessionStore(storeDir),
    agentFactory?: AgentFactory,
  ) {
    this.agentFactory = agentFactory ?? TuiRuntime.defaultAgentFactory(this.harness);
  }

  private static defaultAgentFactory(harness: HarnessServiceClient): AgentFactory {
    return async (workingDirectory, model, question, host) => {
      const gate = new ToolPermissionGate({
        resolveMode: () => host.resolvePermissionMode(),
        requestApproval: (request) => host.requestApproval(request),
      });
      const builder = new AgentBuilder().withDiagnosticObserver((sessionId, observation) => harness.observe(sessionId, observation))
        .withWorkingDirectory(workingDirectory)
        .withSessionStore(host.getSessionStore())
        .withModel(model.provider, {
          apiKey: model.apiKey,
          modelId: model.modelId,
          baseUrl: model.baseUrl,
        })
        .withTool(new AskUserTool(question))
        .withTool(new DispatchAgentTool((agentName, task, sessionId) => host.dispatchSubagent(agentName, task, sessionId)))
        .withToolPermissionGate(gate);
      const journal = host.getCheckpointJournal();
      if (journal) {
        builder.withToolExecutorDecorator((executor) => new CheckpointAwareToolExecutor(executor, journal));
      }
      const agent = await builder.build();

      const entries = host.getMcpServers();
      if (entries.length > 0) {
        const manager = new MCPManager(builder.getToolRegistry());
        const statuses: McpStatus[] = [];
        for (const entry of entries) {
          statuses.push(await connectMcpEntry(manager, entry));
        }
        host.registerMcp({ manager, statuses });
      }
      return { agent, skills: builder.getSkillRegistry().getAll() };
    };
  }

  resolvePermissionMode(): ToolPermissionMode {
    return this.permissionMode;
  }

  requestApproval(request: ToolPermissionRequest): Promise<ToolApprovalDecision> {
    return this.harness.withUserWait(request.sessionId, () => this.approvalHandler(request));
  }

  getSessionStore(): ISessionStore {
    return this.sessionStore;
  }

  getMcpServers(): McpServerEntry[] {
    return this.mcpEntries;
  }

  getCheckpointJournal(): IFileCheckpointJournal | null {
    return this.checkpointJournal;
  }

  registerMcp(state: McpRuntimeState): void {
    // Drop servers of a previous build so project/model switches do not leak them.
    const previous = this.mcpState;
    if (previous) {
      for (const status of previous.statuses) {
        if (status.connected) void previous.manager.disconnectServer(status.id).catch(() => {});
      }
    }
    this.mcpState = state;
  }

  reportSubagentActivity(activity: SubagentActivity): void {
    this.dispatchReporter(activity);
  }

  async dispatchSubagent(agentName: string, task: string, _parentSessionId: string): Promise<DispatchResult> {
    try {
      const now = new Date().toISOString();
      const subSession = await this.sessionStore.create({
        id: randomUUID(),
        projectId: "",
        title: `sub:${agentName}`,
        status: "idle",
        messages: [],
        events: [],
        created: now,
        updated: now,
        metadata: { source: "tui-subagent", workingDirectory: this.workingDirectory, agentName },
      });
      const child = await this.buildSubagent(agentName);
      let toolCalls = 0;
      let finalText = "";
      for await (const event of child.run(task, subSession.id)) {
        if (event.type === "tool_call") {
          toolCalls += 1;
          this.dispatchReporter({ agentName, kind: "tool", name: event.toolCall.name });
        }
        if (event.type === "text_chunk") finalText += event.text;
        if (event.type === "done") finalText = event.finalText || finalText;
        if (event.type === "error") {
          return { status: "failed", agentName, subSessionId: subSession.id, error: event.message };
        }
      }
      const summary = (finalText.trim() || `子代理 ${agentName} 完成（${toolCalls} 次工具调用）`).slice(0, 800);
      this.dispatchReporter({ agentName, kind: "done" });
      return { status: "completed", agentName, subSessionId: subSession.id, summary };
    } catch (error) {
      return {
        status: "failed",
        agentName,
        subSessionId: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Child loop: same model/tools/permissions/checkpoints, but cannot dispatch again. */
  private async buildSubagent(agentName: string): Promise<IAgentLoop> {
    const gate = new ToolPermissionGate({
      resolveMode: () => this.permissionMode,
      requestApproval: (request) => this.approvalHandler(request),
    });
    const builder = new AgentBuilder()
      .withWorkingDirectory(this.workingDirectory)
      .withSessionStore(this.sessionStore)
      .withModel(this.model.provider, {
        apiKey: this.model.apiKey,
        modelId: this.model.modelId,
        baseUrl: this.model.baseUrl,
      })
      .withSystemPrompt(`你是被主代理派发的子代理（角色：${agentName}）。专注完成派发任务，直接给出结果。`)
      .withToolPermissionGate(gate);
    const journal = this.getCheckpointJournal();
    if (journal) {
      builder.withToolExecutorDecorator((executor) => new CheckpointAwareToolExecutor(executor, journal));
    }
    return builder.build();
  }

  setQuestionHandler(handler: QuestionHandler): void {
    this.questionHandler = handler;
  }

  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  setPermissionMode(mode: ToolPermissionMode): void {
    this.permissionMode = mode;
  }

  setDispatchReporter(reporter: SubagentReporter): void {
    this.dispatchReporter = reporter;
  }

  setMcpServers(entries: McpServerEntry[]): void {
    this.mcpEntries = entries;
  }

  getMcpStatuses(): McpStatus[] {
    return this.mcpState?.statuses ?? [];
  }

  async reconnectMcp(id: string): Promise<McpStatus> {
    if (!this.mcpState) throw new Error("没有已配置的 MCP 服务");
    const entry = this.mcpEntries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`找不到 MCP 配置 ${id}`);
    const existing = this.mcpState.statuses.find((status) => status.id === id);
    if (existing?.connected) await this.mcpState.manager.disconnectServer(id).catch(() => {});
    const status = await connectMcpEntry(this.mcpState.manager, entry);
    this.mcpState.statuses = [
      ...this.mcpState.statuses.filter((candidate) => candidate.id !== id),
      status,
    ];
    return status;
  }

  async disconnectMcp(id: string): Promise<void> {
    if (!this.mcpState) throw new Error("没有已配置的 MCP 服务");
    await this.mcpState.manager.disconnectServer(id);
    this.mcpState.statuses = this.mcpState.statuses.map((status) =>
      status.id === id ? { ...status, connected: false, tools: [] } : status);
  }

  /** Disconnect every MCP server on TUI shutdown so no child handle outlives the process. */
  async shutdownMcp(): Promise<void> {
    const state = this.mcpState;
    if (!state) return;
    for (const status of state.statuses) {
      if (status.connected) await state.manager.disconnectServer(status.id).catch(() => {});
    }
    this.mcpState = null;
  }

  get journal(): IFileCheckpointJournal {
    return this.checkpointJournal;
  }

  closeHarness(): void { this.harness.close(); }

  async initialize(): Promise<RuntimeSnapshot> {
    this.harness.setModel(this.model);
    await this.harness.start();
    await fsp.mkdir(this.storeDir, { recursive: true });
    const built = await this.agentFactory(this.workingDirectory, this.model, (request) => this.questionHandler(request), this);
    this.agent = built.agent;
    this.skillsCache = built.skills;
    await this.newSession();
    process.chdir(this.workingDirectory);
    return this.snapshot();
  }

  snapshot(): RuntimeSnapshot {
    return {
      workingDirectory: this.workingDirectory,
      model: this.model,
      sessionId: this.currentSessionId,
      skills: [...this.skillsCache],
    };
  }

  async newSession(): Promise<string> {
    const now = new Date().toISOString();
    const session = await this.sessionStore.create({
      id: randomUUID(),
      projectId: "",
      title: "TUI 会话",
      status: "idle",
      messages: [],
      events: [],
      created: now,
      updated: now,
      metadata: {
        source: "tui",
        workingDirectory: this.workingDirectory,
        provider: this.model.provider,
        modelId: this.model.modelId,
      },
    });
    this.currentSessionId = session.id;
    this.sessionTitled = false;
    return session.id;
  }

  private async readSessions(): Promise<SessionSummary[]> {
    try {
      const sessionDir = `${this.storeDir}/.sessions`;
      const files = (await fsp.readdir(sessionDir)).filter((file) => file.endsWith(".json"));
      const rows: SessionSummary[] = [];
      for (const file of files) {
        try {
          const session = JSON.parse(await fsp.readFile(`${sessionDir}/${file}`, "utf8")) as Partial<Session>;
          if (!session.id) continue;
          rows.push({ id: session.id, title: session.title || session.id.slice(0, 8), created: session.created ?? "" });
        } catch {}
      }
      return rows.sort((a, b) => b.created.localeCompare(a.created));
    } catch {
      return [];
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    return (await this.readSessions()).slice(0, 12);
  }

  async openSession(idPrefix: string): Promise<string> {
    const sessions = await this.readSessions();
    const match = sessions.find((session) => session.id.startsWith(idPrefix));
    if (!match) throw new Error(`找不到会话 ${idPrefix}`);
    this.currentSessionId = match.id;
    this.sessionTitled = true;
    return match.id;
  }

  /** Read the persisted user/assistant turns of a session for transcript replay. */
  async loadSessionTranscript(idPrefix: string): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const sessions = await this.readSessions();
    const match = sessions.find((session) => session.id.startsWith(idPrefix));
    if (!match) throw new Error(`找不到会话 ${idPrefix}`);
    const session = await this.sessionStore.get(match.id);
    return (session?.messages ?? [])
      .filter((message): message is typeof message & { role: "user" | "assistant" } =>
        (message.role === "user" || message.role === "assistant") && Boolean(message.content.trim()))
      .slice(-200)
      .map((message) => ({ role: message.role, content: message.content }));
  }

  async run(input: string, onEvent: (event: AgentEvent) => void, images?: string[]): Promise<void> {
    if (!this.agent) throw new Error("Agent 尚未初始化");
    onEvent({ type: "thinking", message: "Preparing context..." });
    await this.sessionStore.addMessage(this.currentSessionId, {
      role: "user",
      content: input,
      ...(images && images.length > 0 ? { images } : {}),
    });
    if (!this.sessionTitled) {
      this.sessionTitled = true;
      const firstLine = input.trim().split("\n")[0]?.slice(0, 24).trim();
      if (firstLine) await this.sessionStore.update(this.currentSessionId, { title: firstLine });
    }
    // Files written from this point on belong to one undo batch.
    this.checkpointJournal.beginBatch();
    let assistantText = "";
    for await (const event of this.harness.monitor(this.agent.run(input, this.currentSessionId, images), {
      input, sessionId: this.currentSessionId, workingDirectory: this.workingDirectory,
    })) {
      if (event.type === "text_chunk") assistantText += event.text;
      onEvent(event);
      if (event.type === "done") {
        const finalText = (event.finalText || assistantText).trim();
        if (finalText) {
          await this.sessionStore.addMessage(this.currentSessionId, { role: "assistant", content: finalText });
        }
      }
    }
  }

  abort(): void {
    this.agent?.abort();
  }

  async compactSession(sessionId: string): Promise<SessionCompaction | null> {
    if (!this.agent?.compactSession) return null;
    return this.agent.compactSession(sessionId);
  }

  async steer(input: string): Promise<void> {
    if (!this.agent || !this.currentSessionId) throw new Error("Agent 尚未初始化");
    await this.sessionStore.addMessage(this.currentSessionId, {
      role: "user",
      content: input,
      name: "__steer__",
    });
  }

  async switchProject(nextDirectory: string): Promise<RuntimeSnapshot> {
    const resolved = await fsp.realpath(nextDirectory);
    const built = await this.agentFactory(resolved, this.model, (request) => this.questionHandler(request), this);
    this.workingDirectory = resolved;
    this.agent = built.agent;
    this.skillsCache = built.skills;
    process.chdir(resolved);
    process.stdout.write(`\x1b]7;${pathToFileURL(resolved).href}\x07`);
    await this.newSession();
    return this.snapshot();
  }

  async switchModel(nextModel: ModelSelection): Promise<RuntimeSnapshot> {
    const built = await this.agentFactory(this.workingDirectory, nextModel, (request) => this.questionHandler(request), this);
    this.model = nextModel;
    this.harness.setModel(nextModel);
    this.agent = built.agent;
    this.skillsCache = built.skills;
    await this.newSession();
    return this.snapshot();
  }
}
