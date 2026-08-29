import {
  AgentBuilder,
  SQLiteSessionStore,
  AskUserTool,
  type IAgentLoop,
  type AgentEvent,
  type Session,
  type AskUserRequest,
  type AskUserResponse,
  getDatabase,
  SQLiteProjectStore,
  SQLiteRemoteToolStore,
  type RemoteToolRegistration,
  type Message,
} from "@agent/core";
import { getServerBaseDir } from "../../lib/server-data-dir";

/** Singleton agent host shared across API routes */
class AgentHost {
  private readonly baseDir = getServerBaseDir();
  private builder: AgentBuilder | null = null;
  private readonly sessionStore = new SQLiteSessionStore(this.baseDir);
  private readonly projectStore = new SQLiteProjectStore(this.baseDir);
  private readonly remoteToolStore = new SQLiteRemoteToolStore(getDatabase(this.baseDir).db);
  private readonly defaultRemoteToolsProjectId = process.env.AGENT_PROJECT_ID ?? "default";
  private activeRun: AsyncIterable<AgentEvent> | null = null;
  private activeAgent: IAgentLoop | null = null;
  private activeRunSessionId: string | null = null;
  private subscribers = new Map<string, Set<(event: AgentEvent, id: number) => void>>();
  /** events of the current run per session — replayed to late/reconnecting subscribers */
  private recentEvents = new Map<string, { id: number; event: AgentEvent }[]>();
  private eventCounters = new Map<string, number>();
  private pendingQuestions = new Map<
    string,
    {
      resolve: (response: AskUserResponse) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor() {
    // Configure model from environment variables
    const apiKey = process.env.AGENT_API_KEY;
    const provider = (process.env.AGENT_MODEL_PROVIDER || "openai") as
      | "anthropic" | "openai" | "deepseek";
    const modelId = process.env.AGENT_MODEL_ID || "gpt-4o";
    const baseUrl = process.env.AGENT_BASE_URL || undefined;

    const builder = new AgentBuilder().withSessionStore(this.sessionStore);
    builder.withRemoteToolStore(this.remoteToolStore, this.defaultRemoteToolsProjectId);
    if (apiKey) {
      builder.withModel(provider, { apiKey, modelId, baseUrl });
    }
    this.builder = builder;
  }

  getBuilder(): AgentBuilder {
    if (!this.builder) {
      this.builder = new AgentBuilder();
    }
    return this.builder;
  }

  setBuilder(builder: AgentBuilder): void {
    builder.withRemoteToolStore(this.remoteToolStore, this.defaultRemoteToolsProjectId);
    this.builder = builder;
  }

  getSessionStore() {
    return this.sessionStore;
  }

  /** Active model info for display (never exposes the key). */
  getModelConfig() {
    return {
      provider: (process.env.AGENT_MODEL_PROVIDER || "openai") as string,
      modelId: process.env.AGENT_MODEL_ID || "gpt-4o",
      baseUrl: process.env.AGENT_BASE_URL || "",
    };
  }

  getWebAppBuildId() {
    return (globalThis as typeof globalThis & { __webAppBuildId?: string }).__webAppBuildId ?? "";
  }

  registerRemoteTools(projectId: string, tools: RemoteToolRegistration[]) {
    return this.remoteToolStore.upsertTools(projectId, tools);
  }

  getRemoteToolStore() {
    return this.remoteToolStore;
  }

  async createSession(title: string, projectId = ""): Promise<Session> {
    const now = new Date().toISOString();

    if (projectId) {
      const project = await this.projectStore.get(projectId);
      if (!project) {
        await this.projectStore.create({
          id: projectId,
          name: projectId,
          description: "",
          created: now,
          updated: now,
        });
      }
    }

    return this.sessionStore.create({
      id: crypto.randomUUID(),
      projectId,
      title,
      status: "idle",
      messages: [],
      events: [],
      created: now,
      updated: now,
      metadata: {},
    });
  }

  getLatestEventId(sessionId: string): number {
    return this.eventCounters.get(sessionId) ?? 0;
  }

  subscribe(sessionId: string, fn: (event: AgentEvent, id: number) => void, lastEventId = -1): () => void {
    // Replay buffered events the subscriber missed (late attach after the run
    // already failed, or EventSource auto-reconnect mid-run). Subscribers pass
    // the last SSE id they saw; only newer buffered events are flushed.
    const buffer = this.recentEvents.get(sessionId) ?? [];
    for (const entry of buffer) {
      if (entry.id <= lastEventId) continue;
      try { fn(entry.event, entry.id); } catch { /* ignore */ }
    }
    const subscribers = this.subscribers.get(sessionId) ?? new Set<(event: AgentEvent, id: number) => void>();
    subscribers.add(fn);
    this.subscribers.set(sessionId, subscribers);
    return () => {
      subscribers.delete(fn);
      if (subscribers.size === 0) this.subscribers.delete(sessionId);
    };
  }

  private emit(sessionId: string, event: AgentEvent): void {
    const id = (this.eventCounters.get(sessionId) ?? 0) + 1;
    this.eventCounters.set(sessionId, id);
    const buffer = this.recentEvents.get(sessionId);
    if (buffer) {
      buffer.push({ id, event });
      if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
    }
    for (const fn of this.subscribers.get(sessionId) ?? []) {
      try { fn(event, id); } catch { /* ignore */ }
    }
  }

  private projectMessagesFromEvents(events: AgentEvent[]): Message[] {
    const messages: Message[] = [];
    let streamingAssistant: Message | null = null;

    for (const event of events) {
      if (event.type === "text_chunk") {
        if (!streamingAssistant) {
          streamingAssistant = { role: "assistant", content: "" };
          messages.push(streamingAssistant);
        }
        streamingAssistant.content += event.text;
        continue;
      }

      if (event.type === "tool_call") {
        if (streamingAssistant && !streamingAssistant.toolCalls) {
          streamingAssistant.toolCalls = [event.toolCall];
        } else {
          messages.push({ role: "assistant", content: "", toolCalls: [event.toolCall] });
        }
        streamingAssistant = null;
        continue;
      }

      if (event.type === "tool_result") {
        messages.push({
          role: "tool",
          content: event.result.content,
          toolCallId: event.result.toolCallId,
        });
        continue;
      }

      if ((event as { type?: string }).type === "ask_user") {
        messages.push({
          role: "assistant",
          content: "",
        } as Message);
        streamingAssistant = null;
        continue;
      }

      if (event.type === "done") {
        if (streamingAssistant) {
          streamingAssistant.content = event.finalText || streamingAssistant.content;
        } else if (event.finalText?.trim()) {
          messages.push({ role: "assistant", content: event.finalText });
        }
        streamingAssistant = null;
      }
    }

    return messages;
  }

  async run(input: string, sessionId: string, images?: string[]): Promise<void> {
    const session = await this.sessionStore.get(sessionId);
    await this.sessionStore.addMessage(sessionId, { role: "user", content: input });
    // a fresh run restarts the event sequence; late subscribers replay only it
    this.eventCounters.set(sessionId, 0);
    this.recentEvents.set(sessionId, []);
    const runProjectId = session?.projectId || this.defaultRemoteToolsProjectId;
    let agent: IAgentLoop;
    try {
      agent = await this.getBuilder()
        .withRemoteToolStore(this.remoteToolStore, runProjectId)
        .withTool(new AskUserTool(async (request: AskUserRequest) => {
          return this.createQuestion(request, sessionId);
        }))
        .build();
    } catch (err) {
      // Emit error to SSE subscribers so the SDK can display it
      const errorEvent = {
        type: "error",
        message: err instanceof Error ? err.message : "Failed to build agent",
      } as AgentEvent;
      try { await this.sessionStore.addEvent(sessionId, errorEvent); } catch {}
      this.emit(sessionId, errorEvent);
      throw err;
    } finally {
      this.builder?.withRemoteToolStore(this.remoteToolStore, this.defaultRemoteToolsProjectId);
    }

    this.activeAgent = agent;
    this.activeRunSessionId = sessionId;
    this.activeRun = agent.run(input, sessionId, images);
    let runFailed = false;

    try {
      for await (const event of this.activeRun) {
        await this.sessionStore.addEvent(sessionId, event);

        if (event.type === "error") {
          runFailed = true;
          await this.sessionStore.update(sessionId, { status: "failed" });
        } else if (event.type === "done" && !runFailed) {
          if (event.finalText.trim()) {
            await this.sessionStore.addMessage(sessionId, { role: "assistant", content: event.finalText });
          }
          await this.sessionStore.update(sessionId, { status: "completed" });
        }

        this.emit(sessionId, event);
      }
    } catch (err) {
      // The loop itself threw (not an in-band error event) — without this the
      // subscriber would wait forever with no feedback.
      runFailed = true;
      const errorEvent = {
        type: "error",
        message: err instanceof Error ? err.message : "Agent run failed",
      } as AgentEvent;
      try {
        await this.sessionStore.addEvent(sessionId, errorEvent);
        await this.sessionStore.update(sessionId, { status: "failed" });
      } catch {}
      this.emit(sessionId, errorEvent);
    } finally {
      if (this.activeRunSessionId === sessionId) {
        this.activeAgent = null;
        this.activeRunSessionId = null;
      }
      this.activeRun = null;
    }

    // Persist a stable SDK-facing message projection from the recorded events
    try {
      const stored = await this.sessionStore.get(sessionId);
      const userMessages = (stored?.messages ?? []).filter((message) => message.role === "user");
      const projected = this.projectMessagesFromEvents(stored?.events ?? []);
      await this.sessionStore.replaceMessages(sessionId, [...userMessages, ...projected]);
    } catch {
      // ignore persistence errors
    }
  }

  /** Create a pending question and emit ask_user event to SSE subscribers */
  private createQuestion(
    request: AskUserRequest,
    sessionId: string,
  ): Promise<AskUserResponse> {
    const questionId = crypto.randomUUID();
    this.emit(
      sessionId,
      {
        type: "ask_user" as any,
        ...({
          questionId,
          question: request.question,
          options: request.options,
          multiSelect: request.multiSelect,
        } as any),
      } as AgentEvent,
    );
    return new Promise<AskUserResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingQuestions.has(questionId)) {
          this.pendingQuestions.delete(questionId);
          reject(new Error("Question timed out after 5 minutes"));
        }
      }, 5 * 60 * 1000);
      this.pendingQuestions.set(questionId, { resolve, reject, timer });
    });
  }

  /** Resolve a pending question — called from /api/agent/answer */
  answerQuestion(
    questionId: string,
    answer: string,
    selectedIndices?: number[],
  ): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingQuestions.delete(questionId);
    pending.resolve({ answer, selectedIndices });
    return true;
  }

  /**
   * Inject a user message into a running agent loop (picked up on the next
   * iteration via the __steer__ mailbox, same protocol as desktop).
   * Returns false when no run is active for this session — the caller
   * should start a new run instead.
   */
  async steer(input: string, sessionId: string): Promise<boolean> {
    await this.sessionStore.addMessage(sessionId, {
      role: "user",
      content: input,
      name: "__steer__",
    } as Message);
    if (this.activeRunSessionId === sessionId && this.activeAgent) {
      this.emit(sessionId, { type: "thinking", message: `User added: ${input.slice(0, 60)}` } as AgentEvent);
      return true;
    }
    return false;
  }

  abort(): void {
    this.activeAgent?.abort();
  }
}

const globalWithAgentHost = globalThis as typeof globalThis & { __agentHost?: AgentHost };

export const agentHost = globalWithAgentHost.__agentHost ?? new AgentHost();
globalWithAgentHost.__agentHost = agentHost;
