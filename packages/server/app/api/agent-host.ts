import {
  AgentBuilder,
  InMemorySessionStore,
  AskUserTool,
  type IAgentLoop,
  type AgentEvent,
  type Session,
  type AskUserRequest,
  type AskUserResponse,
  getDatabase,
  SQLiteRemoteToolStore,
  type RemoteToolRegistration,
} from "@agent/core";

/** Singleton agent host shared across API routes */
class AgentHost {
  private agent: IAgentLoop | null = null;
  private builder: AgentBuilder | null = null;
  private readonly sessionStore = new InMemorySessionStore();
  private readonly remoteToolStore = new SQLiteRemoteToolStore(getDatabase(process.cwd()).db);
  private activeRun: AsyncIterable<AgentEvent> | null = null;
  private subscribers = new Set<(event: AgentEvent) => void>();
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
    builder.withRemoteToolStore(this.remoteToolStore, process.env.AGENT_PROJECT_ID ?? "default");
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
    this.builder = builder;
  }

  getSessionStore(): InMemorySessionStore {
    return this.sessionStore;
  }

  registerRemoteTools(projectId: string, tools: RemoteToolRegistration[]) {
    return this.remoteToolStore.upsertTools(projectId, tools);
  }

  getRemoteToolStore() {
    return this.remoteToolStore;
  }

  async createSession(title: string, projectId = ""): Promise<Session> {
    return this.sessionStore.create({
      id: crypto.randomUUID(),
      projectId,
      title,
      status: "idle",
      messages: [],
      events: [],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      metadata: {},
    });
  }

  subscribe(fn: (event: AgentEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(event: AgentEvent): void {
    for (const fn of this.subscribers) {
      try { fn(event); } catch { /* ignore */ }
    }
  }

  async run(input: string, sessionId: string): Promise<void> {
    let agent: IAgentLoop;
    try {
      agent = await this.getBuilder().build();
    } catch (err) {
      // Emit error to SSE subscribers so the SDK can display it
      this.emit({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to build agent",
      } as AgentEvent);
      throw err;
    }

    // Register AskUserTool with a callback that emits the question
    // to SSE subscribers and waits for the answer via /api/agent/answer
    this.getBuilder().getToolRegistry().register(
      new AskUserTool(async (request: AskUserRequest) => {
        return this.createQuestion(request, sessionId);
      }),
    );

    this.activeRun = agent.run(input, sessionId);

    for await (const event of this.activeRun) {
      this.emit(event);
      await this.sessionStore.addEvent(sessionId, event);

      if (event.type === "done") {
        await this.sessionStore.update(sessionId, { status: "completed" });
      }
    }
  }

  /** Create a pending question and emit ask_user event to SSE subscribers */
  private createQuestion(
    request: AskUserRequest,
    sessionId: string,
  ): Promise<AskUserResponse> {
    const questionId = crypto.randomUUID();
    this.emit(
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

  abort(): void {
    this.agent?.abort();
    this.activeRun = null;
  }
}

const globalWithAgentHost = globalThis as typeof globalThis & { __agentHost?: AgentHost };

export const agentHost = globalWithAgentHost.__agentHost ?? new AgentHost();
globalWithAgentHost.__agentHost = agentHost;
