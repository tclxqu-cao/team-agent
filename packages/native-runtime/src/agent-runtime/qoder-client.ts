import { randomUUID } from "node:crypto";
import type { AgentEvent, Message } from "@agent/core";
import { AsyncEventQueue } from "./async-event-queue.js";
import { parseImageDataUrls } from "./image-input.js";
import { resolveNativeCliCommand } from "./native-cli-command.js";
import { NativeRpcClient, nativeRecord, type NativeRpcConnection } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { RuntimeSessionError, type CreateRuntimeSessionOptions, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";
import { QoderWorkspaceCatalog } from "./qoder-workspace-catalog.js";
import { QoderSessionHistory } from "./qoder-session-history.js";

interface Run {
  queue: AsyncEventQueue<AgentEvent>;
  text: string;
  aborted: boolean;
  reasoningId: string;
  reasoningActive: boolean;
  historyMessageIds: Set<string>;
  historyToolIds: Set<string>;
}

interface Permission {
  sessionId: string;
  options: NativeJsonPacket[];
  resolve(result: unknown): void;
}

function records(value: unknown): NativeJsonPacket[] { return Array.isArray(value) ? value.map(nativeRecord) : []; }
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).join("");
  const part = nativeRecord(value);
  return typeof part.text === "string" ? part.text : part.content ? textContent(part.content) : "";
}
function timestamp(value: unknown): string {
  const date = new Date(typeof value === "string" || typeof value === "number" ? value : Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/** Qoder's ACP contract. No CA provider profile or native credential is copied. */
export class QoderClient implements NativeSessionProtocol {
  private initializing: Promise<void> | null = null;
  private readonly sessions = new Map<string, NativeProtocolSession>();
  private readonly loaded = new Set<string>();
  private readonly unpersistedSessions = new Set<string>();
  private readonly histories = new Map<string, Message[]>();
  private readonly historyLoads = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, Run>();
  private readonly permissions = new Map<string, Permission>();
  private models: RuntimeModelInfo[] = [];
  private readonly unsubscribe: Array<() => void>;

  constructor(
    private readonly rpc: NativeRpcConnection = new NativeRpcClient(() => resolveNativeCliCommand("qoder")),
    private readonly workspaces: Pick<QoderWorkspaceCatalog, "list"> = new QoderWorkspaceCatalog(),
    private readonly historySource: Pick<QoderSessionHistory, "read"> = new QoderSessionHistory(),
  ) {
    rpc.onRequest((method, params) => this.callback(method, params));
    this.unsubscribe = [rpc.onNotification((method, params) => this.notification(method, params)), rpc.onFailure(error => {
      this.initializing = null; this.loaded.clear(); this.unpersistedSessions.clear();
      for (const [id, run] of this.runs) {
        this.cancelPermissions(id);
        run.queue.push({ type: "error", code: error.code, message: error.message }); run.queue.close();
      }
    })];
  }

  available(): Promise<void> {
    return this.initializing ??= this.rpc.request("initialize", { protocolVersion: 1,
      clientInfo: { name: "agentroam", version: "1" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }).then(() => {}).catch(error => { this.initializing = null; throw error; });
  }

  private session(row: NativeJsonPacket): NativeProtocolSession {
    if (typeof row.sessionId !== "string" || !row.sessionId) throw new RuntimeSessionError("Qoder returned no native session ID", "NATIVE_PROTOCOL_ERROR");
    const previous = this.sessions.get(row.sessionId);
    const session = { id: row.sessionId, title: typeof row.title === "string" ? row.title : previous?.title ?? "Qoder",
      cwd: typeof row.cwd === "string" ? row.cwd : previous?.cwd ?? "", created: previous?.created ?? timestamp(row.createdAt ?? row.updatedAt),
      updated: timestamp(row.updatedAt ?? previous?.updated), nativePermissions: previous?.nativePermissions };
    this.sessions.set(session.id, session);
    return session;
  }

  async list(): Promise<NativeProtocolSession[]> {
    await this.available();
    const sessions = new Map<string, NativeProtocolSession>();
    const roots = new Set(await this.workspaces.list());
    for (const session of this.sessions.values()) if (session.cwd) roots.add(session.cwd);
    for (const cwd of [undefined, ...roots]) {
      let cursor: string | undefined;
      const visited = new Set<string>();
      do {
        const page = await this.rpc.request("session/list", { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) });
        for (const row of records(page.sessions)) {
          const session = this.session(row);
          const previous = sessions.get(session.id);
          if (!previous || session.updated >= previous.updated) sessions.set(session.id, session);
        }
        cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
        if (cursor && (visited.has(cursor) || visited.size >= 100)) throw new RuntimeSessionError("Qoder session pagination did not terminate", "NATIVE_PROTOCOL_ERROR");
        if (cursor) visited.add(cursor);
      } while (cursor);
    }
    for (const session of sessions.values()) this.sessions.set(session.id, session);
    return [...sessions.values()];
  }

  private captureOptions(id: string, result: NativeJsonPacket): void {
    const models = nativeRecord(result.models);
    if (Array.isArray(models.availableModels)) this.models = records(models.availableModels).flatMap(row => typeof row.modelId === "string"
      ? [{ id: row.modelId, displayName: typeof row.name === "string" ? row.name : row.modelId, description: typeof row.description === "string" ? row.description : undefined }] : []);
    const modes = nativeRecord(result.modes);
    const session = this.sessions.get(id);
    if (session && typeof modes.currentModeId === "string") session.nativePermissions = { currentValue: modes.currentModeId,
      options: records(modes.availableModes).flatMap(mode => typeof mode.id === "string" ? [{ value: mode.id, label: String(mode.name ?? mode.id), description: typeof mode.description === "string" ? mode.description : undefined }] : []) };
  }

  private async load(id: string, replay = false): Promise<void> {
    await this.available();
    const pending = this.historyLoads.get(id);
    if (pending) return pending;
    if (this.loaded.has(id) && this.histories.has(id) && !replay) return;
    const operation = this.reload(id);
    this.historyLoads.set(id, operation);
    try { await operation; }
    finally { if (this.historyLoads.get(id) === operation) this.historyLoads.delete(id); }
  }

  private async reload(id: string): Promise<void> {
    if (this.runs.has(id)) throw new RuntimeSessionError("Qoder history cannot reload during an active turn", "SESSION_ALREADY_RUNNING");
    let session = this.sessions.get(id);
    if (!session) { await this.list(); session = this.sessions.get(id); }
    if (!session) throw new RuntimeSessionError("Qoder session not found", "SESSION_NOT_FOUND");
    try {
      // session/new creates a live writer before its transcript exists. Resume
      // is only for unopened sessions; repeating it can discard a blank writer
      // or fail with "already open" after the first turn. Refresh JSONL instead.
      const unpersisted = this.unpersistedSessions.has(id) && this.loaded.has(id);
      if (!this.loaded.has(id)) {
        const result = await this.rpc.request("session/resume", { sessionId: id, cwd: session.cwd, mcpServers: [] });
        this.captureOptions(id, result); this.loaded.add(id);
      }
      const messages = await this.historySource.read(id).catch(error => {
        if (unpersisted && error instanceof RuntimeSessionError && error.code === "SESSION_NOT_FOUND") return [];
        throw error;
      });
      this.histories.set(id, messages);
      if (messages.length) this.unpersistedSessions.delete(id);
    } catch (error) { this.histories.delete(id); throw error; }
  }

  async read(id: string) {
    // Never replace the active native writer; the broker overlays its live events.
    if (this.runs.has(id) && this.sessions.has(id)) return { session: this.sessions.get(id)!, messages: this.histories.get(id) ?? [] };
    await this.load(id, true);
    return { session: this.sessions.get(id)!, messages: this.histories.get(id) ?? [] };
  }

  async create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession> {
    await this.available();
    const result = await this.rpc.request("session/new", { cwd: options.cwd, mcpServers: [] });
    const session = this.session({ ...result, cwd: options.cwd, title: options.title });
    this.captureOptions(session.id, result); this.loaded.add(session.id); this.histories.set(session.id, []); this.unpersistedSessions.add(session.id);
    return session;
  }

  restoreDraft(session: NativeProtocolSession): void { this.sessions.set(session.id, { ...session }); }

  async listModels(): Promise<RuntimeModelInfo[]> {
    if (!this.models.length) {
      const sessions = await this.list();
      if (sessions[0]) await this.load(sessions[0].id);
    }
    return [...this.models];
  }

  async *run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent> {
    await this.load(id);
    if (this.runs.has(id)) throw new RuntimeSessionError("Qoder session is already running", "SESSION_ALREADY_RUNNING");
    if (options?.reasoningEffort) throw new RuntimeSessionError("Qoder does not expose per-turn reasoning effort", "OPERATION_NOT_SUPPORTED");
    if (options?.model) await this.rpc.request("session/set_model", { sessionId: id, modelId: options.model.id });
    const prompt: NativeJsonPacket[] = [{ type: "text", text: input }, ...parseImageDataUrls(images).map(image => ({ type: "image", mimeType: image.mimeType, data: image.base64 }))];
    const history = this.histories.get(id) ?? [];
    const run: Run = { queue: new AsyncEventQueue(), text: "", aborted: false, reasoningId: randomUUID(), reasoningActive: false,
      historyMessageIds: new Set(history.flatMap(message => message.historyId ? [message.historyId] : [])),
      historyToolIds: new Set(history.flatMap(message => message.toolCalls?.map(call => call.id) ?? [])) };
    this.runs.set(id, run);
    let finished = false;
    const completion = this.rpc.request("session/prompt", { sessionId: id, prompt }, 15 * 60_000).then(result => {
      if (run.aborted || result.stopReason === "cancelled") run.queue.push({ type: "turn_aborted" });
      else run.queue.push({ type: "done", finalText: run.text });
    }).catch(async error => {
      try { await this.abort(id); } catch { /* The process may already have exited. */ }
      run.queue.push({ type: "error", message: error instanceof Error ? error.message : "Qoder prompt failed" });
    }).finally(() => { finished = true; this.cancelPermissions(id); run.queue.close(); });
    try { yield* run.queue; }
    finally {
      if (!finished) await this.abort(id);
      if (this.runs.get(id) === run) this.runs.delete(id);
      await completion;
    }
  }

  async abort(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) return;
    run.aborted = true;
    this.cancelPermissions(id);
    await this.rpc.notify("session/cancel", { sessionId: id });
  }

  private notification(method: string, params: NativeJsonPacket): void {
    if (method !== "session/update" || typeof params.sessionId !== "string") return;
    const id = params.sessionId;
    const update = nativeRecord(params.update);
    const kind = update.sessionUpdate;
    const run = this.runs.get(id);
    if (run && ((typeof update.messageId === "string" && run.historyMessageIds.has(update.messageId))
      || (typeof update.toolCallId === "string" && run.historyToolIds.has(update.toolCallId)))) return;
    if (kind === "agent_message_chunk" || kind === "user_message_chunk") {
      const text = textContent(update.content);
      if (run && kind === "agent_message_chunk") { run.reasoningActive = false; run.text += text; run.queue.push({ type: "text_chunk", text }); }
    } else if (kind === "agent_thought_chunk" && run) {
      if (!run.reasoningActive) { run.reasoningId = randomUUID(); run.reasoningActive = true; }
      run.queue.push({ type: "reasoning_summary_delta", itemId: run.reasoningId, sectionIndex: 0, delta: textContent(update.content) });
    } else if (kind === "tool_call" && typeof update.toolCallId === "string") {
      if (run) run.reasoningActive = false;
      const toolCall = { id: update.toolCallId, name: String(update.title ?? update.kind ?? "Qoder tool"), arguments: nativeRecord(update.rawInput) };
      run?.queue.push({ type: "tool_call", toolCall });
    } else if (kind === "tool_call_update" && typeof update.toolCallId === "string" && (update.status === "completed" || update.status === "failed")) {
      const content = textContent(update.content ?? update.rawOutput);
      const isError = update.status === "failed";
      run?.queue.push({ type: "tool_result", result: { toolCallId: update.toolCallId, content, isError } });
    } else if (kind === "session_info_update") {
      const session = this.sessions.get(id);
      if (session && typeof update.title === "string") session.title = update.title;
    }
  }

  private async callback(method: string, params: NativeJsonPacket): Promise<unknown> {
    if (method !== "session/request_permission") throw new Error("Unsupported Qoder callback");
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const run = this.runs.get(sessionId);
    const options = records(params.options).filter(option => typeof option.optionId === "string");
    if (!run || !options.length) return { outcome: { outcome: "cancelled" } };
    const id = `qoder-permission:${randomUUID()}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.resolvePermission(id, { outcome: { outcome: "cancelled" } }), 10 * 60_000);
      timer.unref?.();
      this.permissions.set(id, { sessionId, options, resolve: result => { clearTimeout(timer); resolve(result); } });
      run.queue.push({ type: "ask_user", questionId: id, question: String(nativeRecord(params.toolCall).title ?? "Qoder requests tool permission"),
        options: options.map(option => ({ label: String(option.name ?? option.optionId), description: String(option.kind ?? "") })) });
    });
  }

  private resolvePermission(id: string, result: unknown): void {
    const pending = this.permissions.get(id);
    if (!pending) return;
    this.permissions.delete(id); pending.resolve(result);
    this.runs.get(pending.sessionId)?.queue.push({ type: "approval_resolved", questionId: id });
  }

  private cancelPermissions(sessionId: string): void {
    for (const [id, pending] of this.permissions) if (pending.sessionId === sessionId) this.resolvePermission(id, { outcome: { outcome: "cancelled" } });
  }

  async answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    const pending = this.permissions.get(id);
    if (!pending) return false;
    const index = answer.selectedIndices?.length === 1 ? answer.selectedIndices[0]
      : pending.options.findIndex(option => option.optionId === answer.answer || option.name === answer.answer);
    const option = pending.options[index];
    if (!option) throw new RuntimeSessionError("Select a native permission option", "QUESTION_ANSWER_FAILED");
    this.resolvePermission(id, { outcome: { outcome: "selected", optionId: option.optionId } });
    return true;
  }

  async dispose(): Promise<void> {
    for (const id of this.runs.keys()) this.cancelPermissions(id);
    await this.rpc.dispose();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.loaded.clear(); this.unpersistedSessions.clear();
  }
}
