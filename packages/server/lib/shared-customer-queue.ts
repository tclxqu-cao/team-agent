import {
  enqueueSessionGoal, enqueueSessionMessage, readSessionGoalState, writeSessionGoalState,
  promoteNextSessionQueueItem, finishActiveSessionGoal, cancelSessionGoal,
  reorderQueuedSessionGoals, reorderQueuedSessionMessages, updateQueuedSessionMessage,
  type ISessionStore, type SessionGoal, type SessionGoalState, type SessionMessagePayload,
} from "@agent/core";

/** One server-owned queue per session; both clients mutate the same metadata. */
export class SharedCustomerQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly draining = new Set<string>();
  constructor(
    private readonly store: ISessionStore,
    private readonly busy: (id: string) => boolean,
    private readonly run: (id: string, item: SessionGoal) => Promise<"completed" | "failed">,
    private readonly abort: (id: string) => void,
    private readonly steerRun: (id: string, text: string) => Promise<boolean>,
    private readonly persist?: (id: string, state: SessionGoalState) => void,
  ) {}
  async get(id: string, resume = true) {
    const state = readSessionGoalState((await this.require(id)).metadata);
    if (resume) this.resume(id);
    return state;
  }
  async enqueue(id: string, objective: string, sourceMessageId?: string) {
    const result = await this.mutate(id, (state) => enqueueSessionGoal(state, { id: crypto.randomUUID(), sessionId: id, objective, sourceMessageId, now: Date.now() }));
    this.resume(id); return result;
  }
  async enqueueMessage(id: string, objective: string, sourceMessageId: string, messagePayload?: SessionMessagePayload) {
    const result = await this.mutate(id, (state) => {
      if ([state.active, ...state.queued, ...state.history].some((item) => item?.sourceMessageId === sourceMessageId)) return state;
      return enqueueSessionMessage(state, { id: crypto.randomUUID(), sessionId: id, objective, sourceMessageId, messagePayload, now: Date.now(), activate: false });
    });
    this.resume(id); return result;
  }
  reorder(id: string, ids: string[], messages = false) { return this.mutate(id, (state) => messages ? reorderQueuedSessionMessages(state, ids) : reorderQueuedSessionGoals(state, ids)); }
  updateMessage(id: string, itemId: string, text: string, payload?: SessionMessagePayload) { return this.mutate(id, (state) => updateQueuedSessionMessage(state, itemId, text, payload)); }
  async cancel(id: string, itemId: string) {
    const result = await this.mutate(id, (state) => {
      if (state.active?.id === itemId && this.draining.has(id)) this.abort(id);
      return cancelSessionGoal(state, itemId, Date.now());
    });
    this.resume(id); return result;
  }
  async steer(id: string, itemId: string) {
    return this.mutate(id, async (state) => {
      const item = state.queued.find((item) => item.id === itemId && item.kind === "message");
      if (!item || !this.busy(id)) throw new Error("没有可引导的运行或排队消息");
      if (!await this.steerRun(id, item.objective)) throw new Error("运行已结束，请继续排队");
      return cancelSessionGoal(state, itemId, Date.now());
    });
  }
  resume(id: string) {
    if (this.draining.has(id)) return;
    this.draining.add(id);
    void this.drain(id).catch((error) => console.error("Customer queue failed", error)).finally(() => this.draining.delete(id));
  }
  private async drain(id: string) {
    while (true) {
      const state = await this.get(id, false);
      if (!state.active && !state.queued.length) return;
      if (this.busy(id)) { await new Promise((resolve) => setTimeout(resolve, 100)); continue; }
      const ready = await this.mutate(id, (current) => promoteNextSessionQueueItem(current, Date.now()));
      const item = ready.active;
      if (!item) continue;
      let outcome: "completed" | "failed" = "failed";
      let reason: string | undefined;
      try { outcome = await this.run(id, item); }
      catch (error) {
        if ((error as { code?: string })?.code === "SESSION_ALREADY_RUNNING") continue;
        reason = error instanceof Error ? error.message : String(error);
      }
      await this.mutate(id, (latest) => latest.active?.id === item.id ? finishActiveSessionGoal(latest, outcome, Date.now(), reason) : latest);
    }
  }
  private async require(id: string) {
    const session = await this.store.get(id);
    if (!session) throw new Error("Session not found");
    return session;
  }
  private async mutate(id: string, change: (state: SessionGoalState) => SessionGoalState | Promise<SessionGoalState>) {
    const operation = (this.tails.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const before = await this.require(id);
      const next = await change(readSessionGoalState(before.metadata));
      if (this.persist) this.persist(id, next);
      else {
        const latest = await this.require(id);
        await this.store.update(id, { metadata: writeSessionGoalState(latest.metadata, next) });
      }
      return next;
    });
    this.tails.set(id, operation);
    try { return await operation; } finally { if (this.tails.get(id) === operation) this.tails.delete(id); }
  }
}
