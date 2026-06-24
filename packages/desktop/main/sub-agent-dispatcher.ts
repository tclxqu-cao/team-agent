import {
  AgentBuilder,
  type AgentEvent,
  type Session,
  type Message,
  type DispatchResult,
  type SettingsData,
  type IAgentLoop,
  type AgentDefinition,
  type SQLiteAgentStore,
  type SQLiteSessionStore,
  type SQLiteSettingsStore,
  type SQLiteMemoryStore,
} from "@agent/core";

/** Callback to register session-level tools on a builder */
export type RegisterSessionToolsFn = (
  builder: AgentBuilder,
  sessionId: string,
  allowDispatch?: boolean,
) => void;

/** Callback to emit an event to subscribers */
export type EmitFn = (event: AgentEvent, sid?: string) => void;

/**
 * Manages sub-agent dispatch, execution, and lifecycle.
 * Extracted from AgentHost to isolate multi-agent coordination concerns.
 */
export class SubAgentDispatcher {
  /** Background sub-agents launched by dispatch_agent (non-blocking) */
  private runningSubAgents = new Map<
    string,
    { promise: Promise<DispatchResult>; abort: () => void }
  >();

  constructor(
    private readonly agentStore: SQLiteAgentStore,
    private readonly sessionStore: SQLiteSessionStore,
    private readonly settingsStore: SQLiteSettingsStore,
    private readonly memoryStore: SQLiteMemoryStore,
    private readonly registerSessionTools: RegisterSessionToolsFn,
    private readonly emit: EmitFn,
  ) {}

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
      metadata: { agentName },
    });
    const subSessionId = subSession.id;

    // Notify UI about the dispatch (includes subSessionId for sidebar linking)
    this.emit({ type: "agent_dispatch", agentName, task, subSessionId }, parentSessionId);

    // Launch the sub-agent in background with abort capability
    const abortController = new AbortController();
    const promise = this.runSubAgentInBackground(
      agentDef,
      agentName,
      task,
      parentSessionId,
      subSessionId,
      abortController,
    );
    this.runningSubAgents.set(subSessionId, {
      promise,
      abort: () => abortController.abort(),
    });
    // Clean up the map entry when done
    promise.finally(() => this.runningSubAgents.delete(subSessionId));

    // Return immediately — don't wait for completion
    return { status: "running", agentName, subSessionId };
  }

  /**
   * Wait for a background sub-agent to complete.
   * Looks up the running promise and awaits it with an optional timeout.
   */
  async wait(subSessionId: string, timeoutMs?: number): Promise<DispatchResult> {
    const entry = this.runningSubAgents.get(subSessionId);
    if (!entry) {
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
      const timeout = new Promise<DispatchResult>((_, reject) =>
        setTimeout(() => reject(new Error("wait_agent timed out")), timeoutMs),
      );
      return Promise.race([promise, timeout]);
    }
    return promise;
  }

  /** Abort all background sub-agents (called when parent turn is interrupted) */
  abortAll(): void {
    for (const [, entry] of this.runningSubAgents) {
      entry.abort();
    }
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
  ): Promise<DispatchResult> {
    const latestSettings = this.settingsStore.getAll();

    // Build a fresh builder for the sub-agent (separate registry)
    const subBuilder = new AgentBuilder()
      .withWorkingDirectory(this.settingsStore.getAll().workingDirectory ?? process.cwd())
      .withMemoryStore(this.memoryStore)
      .withSessionStore(this.sessionStore)
      .withMaxIterations(
        agentDef.maxIterations > 0
          ? agentDef.maxIterations
          : latestSettings.maxIterations,
      );

    // Configure model
    let provider = latestSettings.modelProvider;
    let apiKey = latestSettings.apiKey;
    let baseUrl = latestSettings.baseUrl;
    let modelId = latestSettings.modelId;
    if (agentDef.capabilities.profileId) {
      const profile = latestSettings.profiles.find(
        (p) => p.id === agentDef.capabilities.profileId,
      );
      if (profile) {
        provider = profile.provider;
        apiKey = profile.apiKey;
        baseUrl = profile.baseUrl;
        modelId = profile.modelId;
      }
    }
    subBuilder.withModel(provider, {
      apiKey,
      baseUrl: baseUrl || undefined,
      modelId,
    });

    // Apply system prompt (with identity header)
    let systemPrompt = agentDef.systemPrompt || "";
    for (const ph of agentDef.contextPlaceholders) {
      systemPrompt = systemPrompt.replaceAll(`{{${ph.key}}}`, ph.defaultValue);
    }
    const identityHeader = `# 角色：${agentDef.name}${agentDef.description ? `\n${agentDef.description}` : ""}\n你的名字是「${agentDef.name}」。`;
    subBuilder.withSystemPrompt(systemPrompt ? `${identityHeader}\n\n${systemPrompt}` : identityHeader);

    // Apply tool allowlist
    if (agentDef.capabilities.enabledTools.length > 0) {
      subBuilder.withEnabledTools(agentDef.capabilities.enabledTools);
    }

    // Apply skill allowlist
    if (agentDef.capabilities.enabledSkills.length > 0) {
      subBuilder.withEnabledSkills(agentDef.capabilities.enabledSkills);
    }

    const subAgent = subBuilder.buildSync();
    // If the abort controller was triggered (e.g. parent turn interrupted), abort the sub-agent
    if (abortController.signal.aborted) {
      subAgent.abort();
    } else {
      abortController.signal.addEventListener("abort", () => subAgent.abort(), { once: true });
    }
    // Register session tools so sub-agent can also dispatch further agents
    // Sub-agents do not get dispatch rights (max 1 level, prevent infinite recursion)
    this.registerSessionTools(subBuilder, subSessionId, false);

    // Persist the task as the user message in the child session
    await this.sessionStore.addMessage(subSessionId, {
      role: "user",
      content: task,
    } as Message);

    let finalText = "";
    let assistantText = "";
    const pendingToolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
    const subToolCallNameMap = new Map<string, string>();

    try {
      for await (const event of subAgent.run(task, subSessionId)) {
        // Forward events tagged with the child session ID so UI can route them
        this.emit(event, subSessionId);

        if (event.type === "thinking") {
          // Forward thinking to parent so dispatch card shows status updates
          this.emit({ type: "agent_progress", agentName, subSessionId, text: `[思考] ${event.message}` }, parentSessionId);
        }
        if (event.type === "text_chunk" && event.text) {
          assistantText += event.text;
          finalText += event.text;
          // Stream progress to the parent session so the dispatch card shows live output
          this.emit({ type: "agent_progress", agentName, subSessionId, text: event.text }, parentSessionId);
        }
        if (event.type === "tool_call" && event.toolCall) {
          pendingToolCalls.push(event.toolCall);
          subToolCallNameMap.set(event.toolCall.id, event.toolCall.name);
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

      // Mark child session complete
      await this.sessionStore.update(subSessionId, { status: "completed" }).catch(() => {});
      const summary = finalText.trim() || "(no output)";
      this.emit(
        { type: "agent_done", agentName, subSessionId, status: "completed", summary },
        parentSessionId,
      );
      // Inject mailbox notification into parent session
      await this.injectMailboxNotification(parentSessionId, agentName, subSessionId, "completed", summary);
      return { status: "completed", agentName, subSessionId, summary };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // Mark child session failed
      await this.sessionStore.update(subSessionId, { status: "failed" }).catch(() => {});
      this.emit(
        { type: "agent_done", agentName, subSessionId, status: "failed", error: errorMsg },
        parentSessionId,
      );
      await this.injectMailboxNotification(parentSessionId, agentName, subSessionId, "failed", undefined, errorMsg);
      return { status: "failed", agentName, subSessionId, error: errorMsg };
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
