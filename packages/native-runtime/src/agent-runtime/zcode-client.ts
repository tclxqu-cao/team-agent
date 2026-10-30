import { randomUUID } from "node:crypto";
import type { AgentEvent, Message } from "@agent/core";
import { AsyncEventQueue } from "./async-event-queue.js";
import { resolveNativeCliCommand } from "./native-cli-command.js";
import { NativeRpcClient, NativeRpcError, nativeRecord, type NativeRpcConnection } from "./native-rpc-client.js";
import { zcodeModelProgress } from "./zcode-model-progress.js";
import { ZCodeDesktopActivityReader, type ZCodeActivityReader } from "./zcode-desktop-activity.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { RuntimeSessionError, type CreateRuntimeSessionOptions, type NativeReasoningEffort, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";

interface Run { queue: AsyncEventQueue<AgentEvent>; text: string; aborted: boolean; finished: boolean; lastSeq: number; toolIds: Set<string>; reasoningId: string }
interface Question { sessionId: string; options: NativeJsonPacket[]; resolve(result: NativeJsonPacket): void; cancelled: NativeJsonPacket; inputQuestion?: string }
const rows = (value: unknown): NativeJsonPacket[] => Array.isArray(value) ? value.map(nativeRecord) : [];
const reasoningEfforts: readonly NativeReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const nativeEffort = (value: unknown) => reasoningEfforts.find(effort => effort === value);
const modelRefKey = (providerId: string | undefined, modelId: string) => JSON.stringify([providerId, modelId]);
const desktopActivity = new ZCodeDesktopActivityReader();
const nativeDate = (value: unknown): string => {
  const date = new Date(typeof value === "string" || typeof value === "number" ? value : Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
};

export function decodeZCodeHistory(value: unknown): Message[] {
  const messages: Message[] = [];
  for (const row of rows(value)) {
    const info = nativeRecord(row.info);
    const semantics = nativeRecord(info.semantics);
    if (semantics.uiVisibility === "hidden" || semantics.transcriptVisibility === "hidden") continue;
    if (info.role !== "user" && info.role !== "assistant" && info.role !== "system") continue;
    const parts = rows(row.parts);
    const text = parts.filter(part => part.type === "text").map(part => typeof part.text === "string" ? part.text : "").join("");
    const reasoning = parts.filter(part => part.type === "reasoning" && typeof part.text === "string").map((part, index) => ({ itemId: String(part.id ?? `${info.id}:reasoning:${index}`), sectionIndex: 0, text: String(part.text) }));
    const tools = parts.filter(part => part.type === "tool");
    messages.push({ role: info.role, content: text, historyId: typeof info.id === "string" ? info.id : undefined,
      ...(reasoning.length ? { presentation: { reasoning } } : {}),
      ...(tools.length ? { toolCalls: tools.map(part => ({ id: String(part.callID ?? part.toolCallId ?? part.id), name: String(part.tool ?? part.toolName ?? "ZCode tool"), arguments: nativeRecord(nativeRecord(part.state).input ?? part.input) })) } : {}),
    });
    for (const tool of tools) {
      const state = nativeRecord(tool.state);
      if (state.status !== "completed" && state.status !== "error") continue;
      messages.push({ role: "tool", toolCallId: String(tool.callID ?? tool.toolCallId ?? tool.id), content: typeof state.output === "string" ? state.output : typeof state.error === "string" ? state.error : "", isError: state.status === "error" });
    }
  }
  return messages;
}

/** ZCode's strict NDJSON RPC deliberately has no JSON-RPC version field. */
export class ZCodeClient implements NativeSessionProtocol {
  private readonly sessions = new Map<string, NativeProtocolSession>();
  private readonly loaded = new Set<string>();
  private readonly resumes = new Map<string, Promise<NativeProtocolSession>>();
  private readonly runs = new Map<string, Run>();
  private readonly questions = new Map<string, Question>();
  private models: RuntimeModelInfo[] = [];
  private readonly modelDefaults = new Map<string, NativeReasoningEffort>();
  private readonly childCatalog = new Map<string, { updated: string; ids: string[] }>();
  private readonly unsubscribe: Array<() => void>;

  constructor(private readonly rpc: NativeRpcConnection = new NativeRpcClient(() => resolveNativeCliCommand("zcode"), false),
    private readonly activity: ZCodeActivityReader = desktopActivity) {
    rpc.onRequest((method, params) => this.callback(method, params));
    this.unsubscribe = [rpc.onNotification((method, params) => this.notification(method, params)), rpc.onFailure(error => {
      this.loaded.clear(); this.resumes.clear(); this.models = []; this.modelDefaults.clear();
      for (const [id, run] of this.runs) this.finish(id, run.aborted ? { type: "turn_aborted" } : { type: "error", message: error.message, code: error.code });
    })];
  }

  async available(): Promise<void> { await this.rpc.request("session/list", { limit: 1 }); }

  private session(row: NativeJsonPacket): NativeProtocolSession {
    if (typeof row.sessionId !== "string") throw new RuntimeSessionError("ZCode returned no native session ID", "NATIVE_PROTOCOL_ERROR");
    const previous = this.sessions.get(row.sessionId);
    const workspace = nativeRecord(row.workspace);
    const readOnly = row.sessionKind === "subagent_child" || previous?.readOnly;
    const session: NativeProtocolSession = { id: row.sessionId, title: typeof row.title === "string" && row.title ? row.title : previous?.title ?? "ZCode",
      cwd: typeof workspace.workspacePath === "string" ? workspace.workspacePath : previous?.cwd ?? "",
      created: nativeDate(row.createdAt ?? previous?.created), updated: nativeDate(row.updatedAt ?? previous?.updated),
      running: row.status === "running" || row.status === "waiting", nativePermissions: previous?.nativePermissions,
      parentSessionId: readOnly ? (typeof row.parentSessionId === "string" ? row.parentSessionId : previous?.parentSessionId) : undefined,
      readOnly };
    this.sessions.set(session.id, session);
    return session;
  }

  private snapshot(snapshot: NativeJsonPacket, fullModelCatalog = true): NativeProtocolSession {
    const session = this.session(nativeRecord(snapshot.session));
    const settings = nativeRecord(snapshot.settings);
    const model = nativeRecord(settings.model);
    // session/read only supplies the current model; it is not a replacement catalog.
    if (fullModelCatalog) {
      this.modelDefaults.clear();
      this.models = rows(model.available).flatMap(option => {
        const ref = nativeRecord(option.ref);
        if (typeof ref.modelId !== "string" || typeof ref.providerId !== "string" || option.disabledReason) return [];
        const reasoning = nativeRecord(option.reasoning);
        const efforts = [...new Set(rows(reasoning.levels).flatMap(level => {
          const effort = nativeEffort(level.value);
          return effort ? [effort] : [];
        }))];
        const defaultEffort = nativeEffort(reasoning.defaultLevel);
        if (defaultEffort && efforts.includes(defaultEffort)) this.modelDefaults.set(modelRefKey(ref.providerId, ref.modelId), defaultEffort);
        return [{ id: ref.modelId, providerID: ref.providerId, displayName: String(option.label ?? ref.modelId),
          providerDisplayName: typeof option.providerLabel === "string" ? option.providerLabel : undefined,
          description: typeof option.description === "string" ? option.description : undefined,
          ...(efforts.length ? { reasoningEfforts: efforts } : {}) }];
      });
    }
    // Native mode changes are intentionally not exposed until the method is implemented.
    return session;
  }

  async list(): Promise<NativeProtocolSession[]> {
    const result = await this.rpc.request("session/list", { limit: 10000 });
    const main = rows(result.sessions).map(row => this.session(row));
    const sessions = new Map(main.map(session => [session.id, session]));
    const parents = new Set(main.map(session => session.id));
    for (const id of this.childCatalog.keys()) if (!parents.has(id)) this.childCatalog.delete(id);
    for (let offset = 0; offset < main.length; offset += 8) {
      await Promise.all(main.slice(offset, offset + 8).map(async session => {
        if (this.childCatalog.get(session.id)?.updated === session.updated) return;
        const page = await this.rpc.request("session/subagents", { sessionId: session.id, endedLimit: 100 });
        const ids = Array.isArray(page.childSessionIds) ? page.childSessionIds.filter((id): id is string => typeof id === "string") : [];
        this.childCatalog.set(session.id, { updated: session.updated, ids });
      }));
    }
    const childIds = [...new Set([...this.childCatalog.values()].flatMap(page => page.ids))];
    for (let offset = 0; offset < childIds.length; offset += 64) {
      const page = await this.rpc.request("session/list", { sessionIds: childIds.slice(offset, offset + 64) });
      for (const row of rows(page.sessions)) {
        const session = this.session(row);
        sessions.set(session.id, session);
      }
    }
    return this.withDesktopActivity([...sessions.values()]);
  }

  private async withDesktopActivity(sessions: NativeProtocolSession[]): Promise<NativeProtocolSession[]> {
    const activity = await this.activity.readMany(sessions);
    return sessions.map(session => ({ ...session,
      running: session.running || this.runs.has(session.id) || activity.get(session.id) === true,
    }));
  }

  private async resume(id: string, refresh = false): Promise<NativeProtocolSession> {
    const pending = this.resumes.get(id);
    if (pending) return pending;
    if (this.loaded.has(id) && !refresh) return this.sessions.get(id)!;
    const loading = this.rpc.request("session/resume", { sessionId: id }, 60_000).then(result => {
      const session = this.snapshot(result); this.loaded.add(id);
      return session;
    }).finally(() => {
      if (this.resumes.get(id) === loading) this.resumes.delete(id);
    });
    this.resumes.set(id, loading);
    return loading;
  }

  /** ZCode evicts idle residents without closing its RPC connection. Retry only before a send. */
  private async withActiveSession<T>(id: string, operation: (session: NativeProtocolSession) => Promise<T>): Promise<T> {
    const session = await this.resume(id);
    try { return await operation(session); }
    catch (error) {
      if (!(error instanceof NativeRpcError) || error.nativeCode !== -32004
        || error.message !== `Session is not active: ${id}` || this.runs.has(id)) throw error;
      this.loaded.delete(id);
      return operation(await this.resume(id));
    }
  }

  async read(id: string) {
    return this.withActiveSession(id, async () => {
      const snapshot = await this.rpc.request("session/read", { sessionId: id });
      const history = await this.rpc.request("session/messages", { sessionId: id });
      const [session] = await this.withDesktopActivity([this.snapshot(snapshot, false)]);
      return { session: session!, messages: decodeZCodeHistory(history.messages) };
    });
  }

  async create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession> {
    const result = await this.rpc.request("session/create", {
      workspace: { workspacePath: options.cwd, workspaceKey: options.cwd }, persistence: "immediate", titleGenerationEnabled: false,
    }, 60_000);
    const session = this.snapshot(result);
    session.title = options.title;
    this.loaded.add(session.id);
    return session;
  }

  restoreDraft(session: NativeProtocolSession): void { this.sessions.set(session.id, { ...session }); }

  async listModels(): Promise<RuntimeModelInfo[]> {
    if (!this.models.length) {
      const session = (await this.list()).find(session => !session.running && !this.runs.has(session.id));
      if (session) await this.resume(session.id, true);
    }
    return [...this.models];
  }

  async *run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent> {
    if (images?.length) throw new RuntimeSessionError("ZCode image attachment transport is not yet supported", "OPERATION_NOT_SUPPORTED");
    if (options?.model && !options.model.providerID) throw new RuntimeSessionError("ZCode model selection requires a native provider ID", "NATIVE_PROTOCOL_ERROR");
    if (options?.reasoningEffort && !options.model) throw new RuntimeSessionError("ZCode reasoning effort requires an explicit native model", "OPERATION_NOT_SUPPORTED");
    // Reject external desktop ownership before resume can materialize a second resident.
    const current = this.sessions.get(id) ?? (await this.list()).find(session => session.id === id)
      ?? { id, title: "ZCode", cwd: "", created: "", updated: "" };
    const [observed] = await this.withDesktopActivity([current]);
    if (observed!.running && !this.runs.has(id)) throw new RuntimeSessionError("ZCode session is owned by another process", "SESSION_OCCUPIED");
    const subscribed = await this.withActiveSession(id, async session => {
      const [observed] = await this.withDesktopActivity([session]);
      if (observed!.running && !this.runs.has(id)) throw new RuntimeSessionError("ZCode session is owned by another process", "SESSION_OCCUPIED");
      if (this.runs.has(id)) throw new RuntimeSessionError("ZCode session is already running", "SESSION_ALREADY_RUNNING");
      return this.rpc.request("session/subscribe", { sessionId: id, deliveryKind: "web-remote-replayable", includeSnapshot: false });
    });
    const effort = options?.reasoningEffort ?? (options?.model ? this.modelDefaults.get(modelRefKey(options.model.providerID, options.model.id)) : undefined);
    const run: Run = { queue: new AsyncEventQueue(), text: "", aborted: false, finished: false, lastSeq: typeof subscribed.eventSeq === "number" ? subscribed.eventSeq : 0, toolIds: new Set(), reasoningId: randomUUID() };
    this.runs.set(id, run);
    try {
      const accepted = await this.rpc.request("session/send", { sessionId: id, inputId: randomUUID(), content: input,
        ...(options?.model ? { modelSelection: { providerId: options.model.providerID, modelId: options.model.id,
          ...(effort ? { options: { reasoningLevel: effort } } : {}) } } : {}),
      });
      if (accepted.accepted !== true) throw new RuntimeSessionError("ZCode did not accept the native turn", "NATIVE_PROTOCOL_ERROR");
      yield* run.queue;
    } finally {
      if (!run.finished) await this.abort(id);
      this.runs.delete(id); this.cancelQuestions(id); run.queue.close();
    }
  }

  private finish(id: string, event: AgentEvent): void {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    this.cancelQuestions(id); run.finished = true; run.queue.push(event); run.queue.close();
    const session = this.sessions.get(id); if (session) session.running = false;
  }

  private notification(method: string, params: NativeJsonPacket): void {
    if (method !== "session/event" || typeof params.sessionId !== "string") return;
    const run = this.runs.get(params.sessionId);
    if (!run || run.finished) return;
    if (typeof params.seq === "number") { if (params.seq <= run.lastSeq) return; run.lastSeq = params.seq; }
    const payload = nativeRecord(params.payload);
    if (params.type === "session.updated") {
      const progress = zcodeModelProgress(payload);
      if (progress) run.queue.push(progress);
    } else if (params.type === "model.streaming") {
      if (payload.kind === "text_delta" && typeof payload.delta === "string") { run.text += payload.delta; run.queue.push({ type: "text_chunk", text: payload.delta, turnId: typeof params.turnId === "string" ? params.turnId : undefined }); }
      else if (payload.kind === "reasoning_delta" && typeof payload.delta === "string") run.queue.push({ type: "reasoning_summary_delta", itemId: String(payload.partId ?? params.turnId ?? run.reasoningId), sectionIndex: 0, delta: payload.delta });
      else if (payload.kind === "tool_call" && typeof payload.toolCallId === "string" && !run.toolIds.has(payload.toolCallId)) {
        run.toolIds.add(payload.toolCallId); run.queue.push({ type: "tool_call", toolCall: { id: payload.toolCallId, name: String(payload.toolName ?? "ZCode tool"), arguments: nativeRecord(payload.input) } });
      }
    } else if (params.type === "tool.updated" && typeof payload.toolCallId === "string") {
      if ((payload.kind === "scheduled" || payload.kind === "started") && !run.toolIds.has(payload.toolCallId)) {
        run.toolIds.add(payload.toolCallId); run.queue.push({ type: "tool_call", toolCall: { id: payload.toolCallId, name: String(payload.toolName ?? "ZCode tool"), arguments: nativeRecord(payload.input) } });
      } else if (payload.kind === "result" || payload.kind === "error") run.queue.push({ type: "tool_result", result: { toolCallId: payload.toolCallId, content: typeof payload.output === "string" ? payload.output : typeof payload.result === "string" ? payload.result : String(nativeRecord(payload.error).message ?? ""), isError: payload.kind === "error" } });
    } else if (params.type === "turn.completed") {
      this.finish(params.sessionId, run.aborted ? { type: "turn_aborted" } : { type: "done", finalText: run.text });
    } else if (params.type === "turn.failed") {
      const error = nativeRecord(payload.error);
      this.finish(params.sessionId, run.aborted ? { type: "turn_aborted" } : { type: "error", code: typeof error.code === "string" ? error.code : undefined, message: typeof error.message === "string" ? error.message : "ZCode turn failed" });
    }
  }

  private async callback(method: string, params: NativeJsonPacket): Promise<unknown> {
    if (method === "session/requestRuntimePreferences") return { nativeSearchEnhancementsEnabled: false, toolSearchMode: "off", memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: "preflight-v1" };
    if (method === "interaction/requestProviderRuntimeHeaders") {
      // ZCode's native host owns these credentials, not the CA model profile.
      return { headersApplied: false, errorMessage: "ZCode requires its native host account bridge for model credentials; AgentRoam does not substitute CA model credentials." };
    }
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const run = this.runs.get(sessionId);
    if (method !== "interaction/requestPermission" && method !== "interaction/requestUserInput") throw new Error("Unsupported ZCode callback");
    const cancelled = method === "interaction/requestPermission" ? { decision: "deny", reason: "No active user approval" } : { action: "cancel" };
    if (!run) return cancelled;
    const input = rows(params.questions);
    if (method === "interaction/requestUserInput" && input.length !== 1) return { action: "decline", reason: "This input form is not supported" };
    const inputQuestion = method === "interaction/requestUserInput" ? input[0] : undefined;
    const options = rows(inputQuestion ? inputQuestion.options : params.options);
    const id = `zcode-interaction:${randomUUID()}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.resolveQuestion(id, cancelled), 10 * 60_000); timer.unref?.();
      this.questions.set(id, { sessionId, options, cancelled, inputQuestion: inputQuestion ? String(inputQuestion.question) : undefined,
        resolve: result => { clearTimeout(timer); resolve(result); } });
      run.queue.push({ type: "ask_user", questionId: id, question: inputQuestion ? String(inputQuestion.question) : `${String(params.toolName ?? "ZCode tool")}: ${String(params.reason ?? "Permission requested")}`,
        options: options.length ? options.map(option => ({ label: String(option.label ?? option.name ?? option.value ?? option.optionId), description: typeof option.description === "string" ? option.description : String(option.kind ?? "") })) : undefined });
    });
  }

  private resolveQuestion(id: string, result: NativeJsonPacket): void {
    const pending = this.questions.get(id);
    if (!pending) return;
    this.questions.delete(id); pending.resolve(result);
    this.runs.get(pending.sessionId)?.queue.push({ type: "approval_resolved", questionId: id });
  }

  private cancelQuestions(sessionId: string): void { for (const [id, pending] of this.questions) if (pending.sessionId === sessionId) this.resolveQuestion(id, pending.cancelled); }

  async answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    const pending = this.questions.get(id);
    if (!pending) return false;
    const index = answer.selectedIndices?.length === 1 ? answer.selectedIndices[0] : pending.options.findIndex(option => option.optionId === answer.answer || option.name === answer.answer || option.label === answer.answer || option.value === answer.answer);
    const option = pending.options[index];
    if (pending.inputQuestion) {
      const text = option ? String(option.value ?? option.label) : answer.answer;
      this.resolveQuestion(id, { action: "accept", content: { answers: { [pending.inputQuestion]: text } } });
    } else {
      const response = nativeRecord(option?.response);
      if (!option || typeof response.decision !== "string") throw new RuntimeSessionError("Select a native permission option", "QUESTION_ANSWER_FAILED");
      this.resolveQuestion(id, response);
    }
    return true;
  }

  async abort(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    run.aborted = true; this.cancelQuestions(id);
    await this.rpc.request("session/stop", { sessionId: id });
    this.finish(id, { type: "turn_aborted" });
  }

  async dispose(): Promise<void> {
    for (const id of this.runs.keys()) this.cancelQuestions(id);
    await this.rpc.dispose();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }
}
