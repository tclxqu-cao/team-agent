import {
  AgentBuilder,
  InMemorySessionStore,
  type IAgentLoop,
  type AgentEvent,
  type Session,
} from "@agent/core";

/** Singleton agent host shared across API routes */
class AgentHost {
  private agent: IAgentLoop | null = null;
  private builder: AgentBuilder | null = null;
  private readonly sessionStore = new InMemorySessionStore();
  private activeRun: AsyncIterable<AgentEvent> | null = null;
  private subscribers = new Set<(event: AgentEvent) => void>();

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
    const agent = await this.getBuilder().build();
    this.activeRun = agent.run(input, sessionId);

    for await (const event of this.activeRun) {
      this.emit(event);
      await this.sessionStore.addEvent(sessionId, event);

      if (event.type === "done") {
        await this.sessionStore.update(sessionId, { status: "completed" });
      }
    }
  }

  abort(): void {
    this.agent?.abort();
    this.activeRun = null;
  }
}

export const agentHost = new AgentHost();
