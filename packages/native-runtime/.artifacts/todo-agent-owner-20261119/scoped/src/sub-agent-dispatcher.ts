import {
  AgentBuilder,
  type AgentEvent,
  type Session,
  type Message,
  type DispatchResult,
  type SpawnAgentInput,
  type AgentDefinition,
  type SQLiteAgentStore,
  type SQLiteSessionStore,
  type SQLiteSettingsStore,
  type SQLiteMemoryStore,
  type ToolPermissionGate,
  normalizeToolPermissionMode,
} from "@agent/core";

/** Callback to register session-level tools on a builder */
export type RegisterSessionToolsFn = (
  builder: AgentBuilder,
  sessionId: string,
  allowDispatch?: boolean,
) => void;

/** Callback to emit an event to subscribers */
export type EmitFn = (event: AgentEvent, sid?: string) => void;

export interface DynamicTeamRuntimeOptions {
  maxWorkers: number;
  maxParallel: number;
  workerTimeoutMs: number;
  runId: string;
  profileId?: string;
  enabledTools?: string[];
  enabledSkills?: string[];
  enabledMCPServers?: string[];
  memoryEnabled?: boolean;
  prepareBuilder?: (
    builder: AgentBuilder,
    capabilities: {
      profileId?: string;
      enabledTools: string[];
      enabledSkills: string[];
      enabledMCPServers: string[];
      memoryEnabled?: boolean;
    },
  ) => Promise<{
    applySkills(): Promise<void>;
    close(): Promise<void>;
  }>;
}

interface RunningSubAgent {
  promise: Promise<DispatchResult>;
  agentName: string;
  abort: (code?: string, message?: string) => void;
  dynamic: boolean;
}

interface AbortState {
  code?: string;
  message?: string;
}

/**
 * Manages sub-agent dispatch, execution, and lifecycle.
 * Extracted from AgentHost to isolate multi-agent coordination concerns.
 */
export class SubAgentDispatcher {
  /** Background sub-agents launched by dispatch_agent (non-blocking) */
  private runningSubAgents = new Map<
    string,
    RunningSubAgent
  >();
  private completedSubAgents = new Map<string, DispatchResult>();
  private spawnedDynamicAgents = 0;

  constructor(
    private readonly agentStore: SQLiteAgentStore,
    private readonly sessionStore: SQLiteSessionStore,
    private readonly settingsStore: SQLiteSettingsStore,
    private readonly memoryStore: SQLiteMemoryStore,
    private readonly registerSessionTools: RegisterSessionToolsFn,
    private readonly emit: EmitFn,
    private readonly toolPermissionGate?: ToolPermissionGate,
    private readonly dynamicTeam?: DynamicTeamRuntimeOptions,
  ) {}

  dynamicTeamEnabled(): boolean {
    return this.dynamicTeam !== undefined;
  }

  /**
   * Launch a sub-agent in the background and return immediately.
   * The sub-agent runs asynchronously; its result is stored in runningSubAgents.
   * Call wait() or the wait_agent tool to await the result.
   * When complete, a mailbox notification is injected into the parent session.
   */
  async dispatch(
    agentName: string,
    task: string,
    parentSessionId: string,
  ): Promise<DispatchResult> {
    const allAgents = await this.agentStore.list();
    const agentDef = allAgents.find(
      (a) => a.name.toLowerCase() === agentName.toLowerCase(),
    );
    if (!agentDef) {
      const names = allAgents.map((a) => a.name).join(", ") || "(none)";
      return {
        status: "failed",
        agentName,
        subSessionId: "",
        error: `Agent "${agentName}" not found. Available: ${names}`,
      };
    }

    // Create a dedicated child session so the sub-agent has its own history
    const parentSession = await this.sessionStore.get(parentSessionId);
    const subSession = await this.sessionStore.create({
      id: crypto.randomUUID(),
      projectId: parentSession?.projectId ?? "",
      parentSessionId,
      title: `[${agentName}] ${task.slice(0, 50)}`,
      status: "active",
      messages: [],
      events: [],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      metadata: {
        agentName,
        permissionMode: normalizeToolPermissionMode(parentSession?.metadata.permissionMode),
      },
    });
    const subSessionId = subSession.id;

    // Notify UI about the dispatch (includes subSessionId for sidebar linking)
    this.emit({ type: "agent_dispatch", agentName, task, subSessionId }, parentSessionId);

    // Launch the sub-agent in background with abort capability
    const abortController = new AbortController();
    const abortState: AbortState = {};
    const promise = this.runSubAgentInBackground(
      agentDef,
      agentName,
      task,
      parentSessionId,
      subSessionId,
      abortController,
      abortState,
    );
    const entry: RunningSubAgent = {
      promise,
      agentName,
      dynamic: false,
      abort: (code = "PARENT_CANCELLED", message = "Parent run cancelled") => {
        abortState.code = code;
        abortState.message = message;
        abortController.abort();
      },
    };
    this.track(subSessionId, entry);

    // Return immediately — don't wait for completion
    return { status: "running", agentName, subSessionId };
  }

  /** Create a run-scoped temporary child Agent without writing AgentStore. */
  async spawn(input: SpawnAgentInput, parentSessionId: string): Promise<DispatchResult> {
    const team = this.dynamicTeam;
    if (!team) {
      return this.failedSpawn(input.name, "DYNAMIC_ORCHESTRATION_DISABLED", "Dynamic Agent orchestration is not enabled for this run");
    }
    if (this.spawnedDynamicAgents >= team.maxWorkers) {
      return this.failedSpawn(input.name, "MAX_WORKERS_EXCEEDED", `Dynamic team limit reached (${team.maxWorkers})`);
    }
    const activeDynamic = [...this.runningSubAgents.values()].filter((entry) => entry.dynamic).length;
    if (activeDynamic >= team.maxParallel) {
      return this.failedSpawn(input.name, "MAX_PARALLEL_EXCEEDED", `Dynamic parallel limit reached (${team.maxParallel})`);
    }

    const parentSession = await this.sessionStore.get(parentSessionId);
    if (!parentSession) {
      return this.failedSpawn(input.name, "PARENT_SESSION_NOT_FOUND", `Parent session not found: ${parentSessionId}`);
    }

    const agentId = crypto.randomUUID();
    const now = new Date().toISOString();
    const forbidden = new Set(["spawn_agent", "dispatch_agent", "wait_agent"]);
    const enabledTools = (team.enabledTools ?? []).filter((name) => !forbidden.has(name));
    const definition: AgentDefinition = {
      id: `temporary:${agentId}`,
      name: input.name,
      description: input.role,
      systemPrompt: input.instructions || "Complete the delegated task and return a concise, evidence-backed result.",
      contextPlaceholders: [],
      capabilities: {
        profileId: team.profileId || "",
        enabledTools,
        enabledSkills: [...(team.enabledSkills ?? [])],
        enabledMCPServers: [...(team.enabledMCPServers ?? [])],
      },
      maxIterations: 0,
      isDefault: false,
      created: now,
      updated: now,
    };
    const subSession = await this.sessionStore.create({
      id: crypto.randomUUID(),
      projectId: parentSession.projectId,
      parentSessionId,
      title: `[${input.name}] ${input.task.slice(0, 50)}`,
      status: "active",
      messages: [],
      events: [],
      created: now,
      updated: now,
      metadata: {
        agentName: input.name,
        temporaryAgent: true,
        temporaryAgentId: agentId,
        dynamicTeamRunId: team.runId,
        role: input.role,
        task: input.task,
        permissionMode: normalizeToolPermissionMode(parentSession.metadata.permissionMode),
      },
    });
    const subSessionId = subSession.id;
    this.spawnedDynamicAgents += 1;
    this.emit({
      type: "agent_dispatch",
      agentName: input.name,
      role: input.role,
      task: input.task,
      subSessionId,
      agentId,
      parentSessionId,
    }, parentSessionId);

    const abortController = new AbortController();
    const abortState: AbortState = {};
    const timer = setTimeout(() => {
      abortState.code = "AGENT_TIMEOUT";
      abortState.message = `Temporary Agent exceeded ${team.workerTimeoutMs}ms`;
      abortController.abort();
    }, team.workerTimeoutMs);
    const promise = this.runSubAgentInBackground(
      definition,
      input.name,
      input.task,
      parentSessionId,
      subSessionId,
      abortController,
      abortState,
      agentId,
      true,
    ).finally(() => clearTimeout(timer));
    this.track(subSessionId, {
      promise,
      agentName: input.name,
      dynamic: true,
      abort: (code = "PARENT_CANCELLED", message = "Parent run cancelled") => {
        abortState.code = code;
        abortState.message = message;
        abortController.abort();
      },
    });
    return { status: "running", agentName: input.name, subSessionId, agentId };
  }

  /**
   * Wait for a background sub-agent to complete.
   * Looks up the running promise and awaits it with an optional timeout.
   */
  async wait(subSessionId: string, timeoutMs?: number): Promise<DispatchResult> {
    const entry = this.runningSubAgents.get(subSessionId);
    if (!entry) {
      const completed = this.completedSubAgents.get(subSessionId);
      if (completed) return completed;
      // Might have already completed and been cleaned up — check session status
      try {
        const session = await this.sessionStore.get(subSessionId);
        if (session) {
          const agentName = (session.metadata as Record<string, unknown>)?.agentName as string ?? "unknown";
          if (session.status === "completed") {
            return { status: "completed", agentName, subSessionId };
          }
          if (session.status === "failed") {
            return { status: "failed", agentName, subSessionId, error: "Sub-agent session failed" };
          }
        }
      } catch {
        // ignore
      }
      return {
        status: "failed",
        agentName: "",
        subSessionId,
        error: `No running sub-agent found for ${subSessionId}. It may have already completed.`,
      };
    }
    const promise = entry.promise;
    if (timeoutMs && timeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<DispatchResult>((_, reject) => {
        timer = setTimeout(() => reject(new Error("wait_agent timed out")), timeoutMs);
      });
      try {
        return await Promise.race([promise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return promise;
  }

  /** Wait until all current children reach a terminal state. */
  async waitForIdle(timeoutMs: number): Promise<DispatchResult[]> {
    const entries = [...this.runningSubAgents.values()];
    if (entries.length === 0) return [...this.completedSubAgents.values()];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        for (const entry of this.runningSubAgents.values()) {
          entry.abort("PARENT_CONVERGENCE_TIMEOUT", "Parent run finished before the temporary Agent completed");
        }
        resolve();
      }, Math.max(1, timeoutMs));
    });
    await Promise.race([Promise.allSettled(entries.map((entry) => entry.promise)).then(() => undefined), timedOut]);
    if (timeout) clearTimeout(timeout);
    if (this.runningSubAgents.size > 0) {
      await Promise.allSettled([...this.runningSubAgents.values()].map((entry) => entry.promise));
    }
    return [...this.completedSubAgents.values()];
  }

  /** Abort all background sub-agents (called when parent turn is interrupted) */
  abortAll(): void {
    for (const [, entry] of this.runningSubAgents) {
      entry.abort("PARENT_CANCELLED", "Parent run cancelled");
    }
  }

  private failedSpawn(agentName: string, code: string, error: string): DispatchResult {
    return { status: "failed", agentName, subSessionId: "", code, error };
  }

  private track(subSessionId: string, entry: RunningSubAgent): void {
    const promise = entry.promise.catch((err): DispatchResult => ({
      status: "failed",
      agentName: entry.agentName,
      subSessionId,
      code: "AGENT_FAILED",
      error: err instanceof Error ? err.message : String(err),
    }));
    this.runningSubAgents.set(subSessionId, { ...entry, promise });
    void promise.then((result) => {
      this.completedSubAgents.set(subSessionId, result);
    }).finally(() => {
      this.runningSubAgents.delete(subSessionId);
    });
  }

  // ── Private implementation ──────────────────────────────────────────────

  /**
   * Execute the sub-agent loop and persist results.
   * Runs as a background promise — does NOT block dispatch().
   */
  private async runSubAgentInBackground(
    agentDef: AgentDefinition,
    agentName: string,
    task: string,
    parentSessionId: string,
    subSessionId: string,
    abortController: AbortController,
    abortState: AbortState,
    agentId?: string,
    dynamic = false,
  ): Promise<DispatchResult> {
    let dynamicResources: Awaited<ReturnType<NonNullable<DynamicTeamRuntimeOptions["prepareBuilder"]>>> | undefined;
    const startedAt = performance.now();

    try {
      const latestSettings = this.settingsStore.getAll();

      // Build a fresh builder for the sub-agent (separate registry).
      const subBuilder = new AgentBuilder()
        .withWorkingDirectory(latestSettings.workingDirectory ?? process.cwd())
        .withMemoryStore(this.memoryStore)
        .withSessionStore(this.sessionStore)
        .withMaxIterations(
          agentDef.maxIterations > 0
            ? agentDef.maxIterations
            : latestSettings.maxIterations,
        );
      if (this.toolPermissionGate) subBuilder.withToolPermissionGate(this.toolPermissionGate);

      let provider = latestSettings.modelProvider;
      let apiKey = latestSettings.apiKey;
      let baseUrl = latestSettings.baseUrl;
      let modelId = latestSettings.modelId;
      let maxOutputTokens = latestSettings.profiles.find(
        (profile) => profile.id === latestSettings.activeProfileId,
      )?.maxOutputTokens;
      let requestTimeoutSeconds = latestSettings.profiles.find(
        (profile) => profile.id === latestSettings.activeProfileId,
      )?.requestTimeoutSeconds;
      if (agentDef.capabilities.profileId) {
        const profile = latestSettings.profiles.find(
          (p) => p.id === agentDef.capabilities.profileId,
        );
        if (profile) {
          provider = profile.provider;
          apiKey = profile.apiKey;
          baseUrl = profile.baseUrl;
          modelId = profile.modelId;
          maxOutputTokens = profile.maxOutputTokens;
          requestTimeoutSeconds = profile.requestTimeoutSeconds;
        }
      }
      if (dynamic && this.dynamicTeam?.prepareBuilder) {
        dynamicResources = await this.dynamicTeam.prepareBuilder(subBuilder, {
          ...(this.dynamicTeam.profileId ? { profileId: this.dynamicTeam.profileId } : {}),
          enabledTools: agentDef.capabilities.enabledTools,
          enabledSkills: agentDef.capabilities.enabledSkills,
          enabledMCPServers: agentDef.capabilities.enabledMCPServers,
          memoryEnabled: this.dynamicTeam.memoryEnabled,
        });
      } else {
        subBuilder.withModel(provider, {
          apiKey,
          baseUrl: baseUrl || undefined,
          modelId,
          timeoutMs: requestTimeoutSeconds === undefined
            ? undefined
            : requestTimeoutSeconds * 1_000,
        });
        subBuilder
          .withMaxTokens((latestSettings.contextWindow ?? 100) * 1000)
          .withMaxOutputTokens(maxOutputTokens)
          .withReasoningEffort(latestSettings.reasoningEffort ?? "off");
      }

      let systemPrompt = agentDef.systemPrompt || "";
      for (const ph of agentDef.contextPlaceholders) {
        systemPrompt = systemPrompt.replaceAll(`{{${ph.key}}}`, ph.defaultValue);
      }
      const identityHeader = `# 角色：${agentDef.name}${agentDef.description ? `\n${agentDef.description}` : ""}\n你的名字是「${agentDef.name}」。`;
      subBuilder.withSystemPrompt(systemPrompt ? `${identityHeader}\n\n${systemPrompt}` : identityHeader);

      if (!dynamicResources) {
        // Persisted Agent definitions use their established empty-means-unrestricted semantics.
        if (agentDef.capabilities.enabledTools.length > 0) {
          subBuilder.withEnabledTools(agentDef.capabilities.enabledTools);
        }
        if (agentDef.capabilities.enabledSkills.length > 0) {
          subBuilder.withEnabledSkills(agentDef.capabilities.enabledSkills);
        }
      }

      const subAgent = dynamicResources ? await subBuilder.build() : subBuilder.buildSync();
      await dynamicResources?.applySkills();
      if (abortController.signal.aborted) {
        subAgent.abort();
      } else {
        abortController.signal.addEventListener("abort", () => subAgent.abort(), { once: true });
      }
      // The callback omits all coordination tools when allowDispatch is false.
      this.registerSessionTools(subBuilder, subSessionId, false);

      await this.sessionStore.addMessage(subSessionId, {
        role: "user",
        content: task,
      } as Message);

      let finalText = "";
      let assistantText = "";
      const pendingToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
      const subToolCallNameMap = new Map<string, string>();

      this.emit({
        type: "agent_started",
        agentName,
        subSessionId,
        agentId,
        parentSessionId,
        startedAt: new Date().toISOString(),
      }, parentSessionId);
      for await (const event of subAgent.run(task, subSessionId)) {
        // Forward events tagged with the child session ID so UI can route them
        this.emit(event, subSessionId);

        if (event.type === "thinking") {
          // Forward thinking to parent so dispatch card shows status updates
          this.emit({ type: "agent_progress", agentName, subSessionId, agentId, parentSessionId, phase: "thinking", text: event.message }, parentSessionId);
        }
        if (event.type === "text_chunk" && event.text) {
          assistantText += event.text;
          finalText += event.text;
          // Stream progress to the parent session so the dispatch card shows live output
          this.emit({ type: "agent_progress", agentName, subSessionId, agentId, parentSessionId, phase: "assistant", text: event.text }, parentSessionId);
        }
        if (event.type === "tool_call" && event.toolCall) {
          pendingToolCalls.push(event.toolCall);
          subToolCallNameMap.set(event.toolCall.id, event.toolCall.name);
          this.emit({
            type: "agent_progress",
            agentName,
            subSessionId,
            agentId,
            parentSessionId,
            phase: "tool",
            toolName: event.toolCall.name,
            text: `Using ${event.toolCall.name}`,
          }, parentSessionId);
        }
        if (event.type === "tool_result" && event.result) {
          if (pendingToolCalls.length > 0) {
            await this.sessionStore.addMessage(subSessionId, {
              role: "assistant",
              content: assistantText,
              toolCalls: [...pendingToolCalls],
            } as Message).catch(() => {});
            assistantText = "";
            pendingToolCalls.length = 0;
          }
          await this.sessionStore.addMessage(subSessionId, {
            role: "tool",
            content: event.result.content,
            toolCallId: event.result.toolCallId,
            name: subToolCallNameMap.get(event.result.toolCallId),
          } as Message).catch(() => {});
        }
        if (event.type === "done") {
          const doneText = (event.finalText ?? assistantText).trim();
          if (doneText) {
            await this.sessionStore.addMessage(subSessionId, {
              role: "assistant",
              content: doneText,
            } as Message).catch(() => {});
          }
        }
      }

      if (abortState.code) throw Object.assign(new Error(abortState.message || "Temporary Agent aborted"), { code: abortState.code });

      // Mark child session complete
      await this.sessionStore.update(subSessionId, { status: "completed" }).catch(() => {});
      const summary = finalText.trim() || "(no output)";
      this.emit(
        { type: "agent_done", agentName, subSessionId, agentId, parentSessionId, status: "completed", summary, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) },
        parentSessionId,
      );
      // Inject mailbox notification into parent session
      await this.injectMailboxNotification(parentSessionId, agentName, subSessionId, "completed", summary);
      return { status: "completed", agentName, subSessionId, agentId, summary };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const code = typeof err === "object" && err !== null && "code" in err
        ? String(err.code)
        : abortState.code || "AGENT_FAILED";
      // Mark child session failed
      await this.sessionStore.update(subSessionId, { status: "failed" }).catch(() => {});
      this.emit(
        { type: "agent_done", agentName, subSessionId, agentId, parentSessionId, status: "failed", code, error: errorMsg, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) },
        parentSessionId,
      );
      await this.injectMailboxNotification(parentSessionId, agentName, subSessionId, "failed", undefined, errorMsg);
      return { status: "failed", agentName, subSessionId, agentId, code, error: errorMsg };
    } finally {
      await dynamicResources?.close().catch(() => {});
    }
  }

  /**
   * Inject a mailbox notification message into the parent session so the main agent
   * can see the sub-agent's completion/failure on its next turn.
   * Uses a special name "__mailbox__" so the AgentLoop can distinguish these.
   */
  private async injectMailboxNotification(
    parentSessionId: string,
    agentName: string,
    subSessionId: string,
    status: "completed" | "failed",
    summary?: string,
    error?: string,
  ): Promise<void> {
    try {
      await this.sessionStore.addMessage(parentSessionId, {
        role: "user",
        content: `[Sub-agent "${agentName}" ${status}]\n${summary || error || "(no output)"}`,
        name: "__mailbox__",
      } as Message);
    } catch {
      // Non-critical — ignore silently
    }
  }
}
