import type { ISessionStore } from "./entities.js";
import {
  cancelSessionGoal,
  enqueueSessionGoal,
  finishActiveSessionGoal,
  readSessionGoalState,
  reorderQueuedSessionGoals,
  writeSessionGoalState,
  type SessionGoalState,
} from "./SessionGoals.js";

export interface CustomerGoalRunResult {
  outcome: "completed" | "failed";
  reason?: string;
}

export class SessionGoalCoordinator {
  private readonly running = new Map<string, Promise<void>>();
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: ISessionStore,
    private readonly runGoal: (sessionId: string, objective: string) => Promise<CustomerGoalRunResult>,
    private readonly abortGoal: (sessionId: string) => Promise<void> | void,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = Date.now,
  ) {}

  async get(sessionId: string, resume = true): Promise<SessionGoalState> {
    const session = await this.requireSession(sessionId);
    const state = readSessionGoalState(session.metadata);
    if (resume && state.active) this.ensureRunning(sessionId);
    return state;
  }

  async enqueue(sessionId: string, objective: string, sourceMessageId?: string): Promise<SessionGoalState> {
    const state = await this.withSessionMutation(sessionId, async () => {
      const session = await this.requireSession(sessionId);
      const next = enqueueSessionGoal(readSessionGoalState(session.metadata), {
        id: this.createId(),
        sessionId,
        objective,
        sourceMessageId,
        now: this.now(),
      });
      await this.store.update(sessionId, { metadata: writeSessionGoalState(session.metadata, next) });
      return next;
    });
    this.ensureRunning(sessionId);
    return state;
  }

  async reorder(sessionId: string, orderedIds: readonly string[]): Promise<SessionGoalState> {
    return this.withSessionMutation(sessionId, async () => {
      const session = await this.requireSession(sessionId);
      const state = reorderQueuedSessionGoals(readSessionGoalState(session.metadata), orderedIds);
      await this.store.update(sessionId, { metadata: writeSessionGoalState(session.metadata, state) });
      return state;
    });
  }

  async cancel(sessionId: string, goalId: string): Promise<SessionGoalState> {
    const { state, wasActive } = await this.withSessionMutation(sessionId, async () => {
      const session = await this.requireSession(sessionId);
      const current = readSessionGoalState(session.metadata);
      const wasActive = current.active?.id === goalId;
      const state = cancelSessionGoal(current, goalId, this.now());
      await this.store.update(sessionId, { metadata: writeSessionGoalState(session.metadata, state) });
      return { state, wasActive };
    });
    if (wasActive) await this.abortGoal(sessionId);
    if (state.active) this.ensureRunning(sessionId);
    return state;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  private ensureRunning(sessionId: string): void {
    if (this.running.has(sessionId)) return;
    const promise = this.drain(sessionId).finally(() => {
      if (this.running.get(sessionId) === promise) this.running.delete(sessionId);
    });
    this.running.set(sessionId, promise);
  }

  private async drain(sessionId: string): Promise<void> {
    while (true) {
      const session = await this.requireSession(sessionId);
      const state = readSessionGoalState(session.metadata);
      const goal = state.active;
      if (!goal) return;

      let result: CustomerGoalRunResult;
      try {
        result = await this.runGoal(sessionId, goal.objective);
      } catch (error) {
        result = { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
      }

      await this.withSessionMutation(sessionId, async () => {
        const latest = await this.requireSession(sessionId);
        const latestState = readSessionGoalState(latest.metadata);
        if (latestState.active?.id !== goal.id) return;
        const next = finishActiveSessionGoal(latestState, result.outcome, this.now(), result.reason);
        await this.store.update(sessionId, { metadata: writeSessionGoalState(latest.metadata, next) });
      });
    }
  }

  private async withSessionMutation<T>(sessionId: string, mutate: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(mutate);
    const tail = operation.then(() => undefined, () => undefined);
    this.mutationTails.set(sessionId, tail);
    try {
      return await operation;
    } finally {
      if (this.mutationTails.get(sessionId) === tail) this.mutationTails.delete(sessionId);
    }
  }

  private async requireSession(sessionId: string) {
    const session = await this.store.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}
