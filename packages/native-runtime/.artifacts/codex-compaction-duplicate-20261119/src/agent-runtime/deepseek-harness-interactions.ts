import type { AgentEvent } from "@agent/core";
import { harnessRecord, type HarnessConnection, type HarnessRecord, type HarnessStream } from "./deepseek-harness-client.js";
import { decodeHarnessQuestions, harnessAnswer, harnessAskEvent, harnessQuestionId, parseHarnessQuestionId,
  type HarnessAnswerItem, type HarnessQuestion, type HarnessQuestionRef } from "./deepseek-harness-interaction-codec.js";
import { RuntimeSessionError, type RuntimeQuestionAnswer } from "./types.js";

interface QuestionBatch {
  sessionId: string;
  requestId: string;
  kind: HarnessQuestionRef["kind"];
  questions: HarnessQuestion[];
  answers: Map<string, HarnessAnswerItem>;
  clientId?: string;
  eventId?: string;
  submitting?: boolean;
}

/** Owns Harness's question waterfall and durable late replies; UI and broker never decide its policy. */
export class HarnessInteractions {
  private opening: Promise<void> | null = null;
  private stream: HarnessStream | null = null;
  private disposed = false;
  private readonly live = new Map<string, QuestionBatch>();
  private readonly continued = new Map<string, QuestionBatch>();
  private readonly visible = new Map<string, Set<string>>();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  constructor(private readonly client: HarnessConnection) {}

  async start(): Promise<void> {
    if (this.disposed || !this.client.open || this.stream) return;
    if (!this.opening) this.opening = this.connect().finally(() => { this.opening = null; });
    await this.opening;
  }

  private async connect(): Promise<void> {
    const stream = await this.client.open!("$events", {});
    const iterator = stream.values[Symbol.asyncIterator]();
    try {
      const opening = await iterator.next();
      if (opening.done || opening.value.type !== "ready" || typeof opening.value.clientId !== "string") {
        throw new RuntimeSessionError("Harness 交互事件连接未就绪", "NATIVE_PROTOCOL_ERROR");
      }
      if (this.disposed) { stream.close(); return; }
      this.stream = stream;
      void this.pump(stream, iterator, opening.value.clientId);
    } catch (error) { stream.close(); throw error; }
  }

  private async pump(stream: HarnessStream, iterator: AsyncIterator<HarnessRecord>, clientId: string): Promise<void> {
    try {
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const frame = next.value;
        if (frame.type === "cancel" && typeof frame.eventId === "string") {
          const batch = this.live.get(frame.eventId);
          if (batch) { this.live.delete(frame.eventId); this.resolve(batch); }
        } else if (frame.type === "waterfall" && typeof frame.eventId === "string" && typeof frame.agentId === "string") {
          if (!["user-questions/request", "approval/request"].includes(String(frame.event))) {
            await this.client.request("$events/result", { clientId, eventId: frame.eventId, outcome: { kind: "next" } });
            continue;
          }
          const request = harnessRecord(frame.request);
          const approval = frame.event === "approval/request";
          const wait = request.wait ? harnessRecord(request.wait) : {};
          const questions = approval ? [{ id: "approval", question: `允许执行 ${String(request.toolName ?? "此操作")}？`,
            detail: typeof request.reason === "string" ? request.reason : undefined,
            options: [{ label: "允许一次", description: "仅批准当前操作" }, { label: "拒绝", description: "拒绝当前操作" }] }]
            : decodeHarnessQuestions(request.questions);
          const batch: QuestionBatch = { sessionId: frame.agentId, kind: approval ? "approval" : "question",
            requestId: !approval && typeof wait.callId === "string" ? wait.callId : frame.eventId,
            clientId, eventId: frame.eventId, questions, answers: new Map() };
          this.live.set(frame.eventId, batch);
          for (const question of questions) this.emit(batch.sessionId, harnessAskEvent(this.ref(batch, question.id), question));
        }
      }
    } catch { /* A subsequent session read reconnects; never replay an answer across generations. */ }
    finally {
      stream.close();
      if (this.stream === stream) this.stream = null;
      for (const [id, batch] of this.live) if (batch.clientId === clientId) {
        this.live.delete(id); this.resolve(batch);
      }
    }
  }

  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener); this.listeners.set(sessionId, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(sessionId); };
  }

  events(sessionId: string, projections: HarnessRecord): AgentEvent[] {
    const view = projections.userQuestions ? harnessRecord(projections.userQuestions) : {};
    const inbox = projections.inbox ? harnessRecord(projections.inbox) : {};
    const queued = new Set<string>();
    for (const lane of [inbox["next-step"], inbox["next-turn"]]) if (Array.isArray(lane)) for (const raw of lane) {
      const source = harnessRecord(raw).source;
      if (source && harnessRecord(source).kind === "user-question-reply") queued.add(String(harnessRecord(source).callId));
    }
    const batches = [...this.live.values()].filter(batch => batch.sessionId === sessionId);
    const currentContinued = new Set<string>();
    if (Array.isArray(view.active)) for (const raw of view.active) {
      const item = harnessRecord(raw);
      if (item.state !== "continued" || typeof item.callId !== "string" || queued.has(item.callId)) continue;
      const key = JSON.stringify([sessionId, item.callId]);
      currentContinued.add(key);
      let batch = this.continued.get(key);
      if (!batch) {
        batch = { sessionId, requestId: item.callId, kind: "question", questions: decodeHarnessQuestions(item.questions), answers: new Map() };
        this.continued.set(key, batch);
      }
      if (!batches.some(live => live.requestId === batch.requestId)) batches.push(batch);
    }
    for (const [key, batch] of this.continued) if (batch.sessionId === sessionId && !currentContinued.has(key)) this.continued.delete(key);
    const events = batches.flatMap(batch => batch.questions.filter(question => !batch.answers.has(question.id))
      .map(question => harnessAskEvent(this.ref(batch, question.id), question)));
    const ids = new Set(events.flatMap(event => event.type === "ask_user" ? [event.questionId] : []));
    for (const id of this.visible.get(sessionId) ?? []) if (!ids.has(id)) events.push({ type: "approval_resolved", questionId: id });
    this.visible.set(sessionId, ids);
    return events;
  }

  async answer(questionId: string, answer: RuntimeQuestionAnswer, readProjections: (id: string) => Promise<HarnessRecord>): Promise<boolean> {
    const ref = parseHarnessQuestionId(questionId);
    if (!ref) return false;
    await this.start();
    this.events(ref.sessionId, await readProjections(ref.sessionId));
    const batch = [...this.live.values(), ...this.continued.values()].find(item => item.sessionId === ref.sessionId
      && item.requestId === ref.requestId && item.kind === ref.kind);
    const question = batch?.questions.find(item => item.id === ref.itemId);
    if (!batch || !question || batch.answers.has(ref.itemId)) return false;
    if (batch.submitting) throw new RuntimeSessionError("此问题正在提交，请稍后重试", "QUESTION_ANSWER_FAILED");
    const item = harnessAnswer(question, answer);
    if (batch.kind === "approval" && (item.custom || !item.selected.length)) {
      throw new RuntimeSessionError("请选择允许一次或拒绝", "QUESTION_ANSWER_FAILED");
    }
    batch.answers.set(question.id, item);
    if (batch.answers.size === batch.questions.length) {
      batch.submitting = true;
      try {
        if (batch.eventId) {
          await this.client.request("$events/result", { clientId: batch.clientId, eventId: batch.eventId,
            outcome: { kind: "result", value: batch.kind === "approval" ? (item.selected[0] === "允许一次" ? "allowed-once" : "rejected")
              : { answers: batch.questions.map(question => batch.answers.get(question.id)!) } } });
          this.live.delete(batch.eventId);
        } else {
          const accepted = await this.client.request("userQuestions/answer", { agentId: ref.sessionId, callId: ref.requestId,
            answer: { answers: batch.questions.map(question => batch.answers.get(question.id)!) } });
          if (accepted !== true) { this.continued.delete(JSON.stringify([ref.sessionId, ref.requestId])); return false; }
        }
      } catch (error) {
        batch.answers.delete(question.id);
        throw new RuntimeSessionError(error instanceof Error ? error.message : "Harness 回答提交失败", "QUESTION_ANSWER_FAILED");
      } finally { batch.submitting = false; }
    }
    this.emit(batch.sessionId, { type: "approval_resolved", questionId });
    return true;
  }

  private ref(batch: QuestionBatch, itemId: string): HarnessQuestionRef {
    return { sessionId: batch.sessionId, kind: batch.kind, requestId: batch.requestId, itemId };
  }
  private resolve(batch: QuestionBatch): void {
    for (const question of batch.questions) this.emit(batch.sessionId, { type: "approval_resolved", questionId: harnessQuestionId(this.ref(batch, question.id)) });
  }
  private emit(sessionId: string, event: AgentEvent): void { for (const listener of this.listeners.get(sessionId) ?? []) listener(event); }

  dispose(): void {
    this.disposed = true; this.stream?.close(); this.stream = null;
    this.live.clear(); this.continued.clear(); this.visible.clear(); this.listeners.clear();
  }
}
