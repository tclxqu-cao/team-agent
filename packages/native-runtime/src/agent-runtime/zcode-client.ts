import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Message, ToolPermissionMode } from "@agent/core";
import { AsyncEventQueue } from "./async-event-queue.js";
import { parseImageDataUrls } from "./image-input.js";
import { persistZCodeImageAttachments, readZCodeHistoryImages } from "./zcode-image-attachments.js";
import { resolveNativeCliCommand } from "./native-cli-command.js";
import { NativeRpcClient, NativeRpcError, nativeRecord, type NativeRpcConnection } from "./native-rpc-client.js";
import { zcodeModelProgress } from "./zcode-model-progress.js";
import { readZCodeTurnDurations } from "./zcode-turn-duration.js";
import { ZCodeDesktopActivityReader, type ZCodeActivityReader } from "./zcode-desktop-activity.js";
import {
  isZCodeQuestionTool,
  parseZCodePendingQuestionId,
  zcodeInteractionId,
  zcodePendingQuestionsFromSnapshot,
  zcodePendingQuestionToolIds,
  zcodeQuestionHistory,
  type ZCodeQuestionHistoryOptions,
} from "./zcode-questions.js";
import { ZCodeSteering } from "./zcode-steering.js";
import { ZCodeDesktopBridge, type ZCodeDesktopGuide } from "./zcode-desktop-bridge.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import type { NativeTodoMcpConfiguration } from "./runtime-tool-injection.js";
import { RuntimeSessionError, type CreateRuntimeSessionOptions, type NativeReasoningEffort, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";

interface Run {
  queue: AsyncEventQueue<AgentEvent>;
  text: string;
  finalMessageId?: string;
  aborted: boolean;
  finished: boolean;
  lastSeq: number;
  toolIds: Set<string>;
  handledQuestionToolIds: Set<string>;
  reasoningId: string;
}
interface Question { sessionId: string; options: NativeJsonPacket[]; resolve(result: NativeJsonPacket): void; cancelled: NativeJsonPacket; inputQuestion?: string; multiSelect?: boolean }
interface PendingQuestion { sessionId: string; interactionId: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }
type PendingQuestionProjection = ReturnType<typeof zcodePendingQuestionsFromSnapshot>;
interface PendingQuestionRead {
  key: string;
  checkedAt: number;
  projection?: PendingQuestionProjection;
}
const rows = (value: unknown): NativeJsonPacket[] => Array.isArray(value) ? value.map(nativeRecord) : [];
const reasoningEfforts: readonly NativeReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
type ZCodeReasoningLevel = NativeReasoningEffort | "enabled" | "disabled";
const nativeReasoningLevel = (value: unknown): ZCodeReasoningLevel | undefined => {
  const level = typeof value === "string" ? value : nativeRecord(value).value;
  return [...reasoningEfforts, "enabled", "disabled"].find(candidate => candidate === level) as ZCodeReasoningLevel | undefined;
};
const todoMcpServers = (configuration: NativeTodoMcpConfiguration): NativeJsonPacket[] => [{
  name: "agentroam-todo", command: configuration.command, args: [...configuration.args],
  env: Object.entries(configuration.env).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => ({ name, value })),
  isolation: "session", alwaysLoad: true,
}];
const modelRefKey = (providerId: string | undefined, modelId: string) => JSON.stringify([providerId, modelId]);
const desktopActivity = new ZCodeDesktopActivityReader();
const HISTORY_BATCH_SIZE = 256;
const HISTORY_RECONCILE_MS = 30_000;
const PENDING_QUESTION_RECHECK_MS = 10_000;
const nativeDate = (value: unknown): string => {
  const date = new Date(typeof value === "string" || typeof value === "number" ? value : Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
};

function isUnavailableResident(error: unknown, id: string): boolean {
  return error instanceof NativeRpcError && error.nativeCode === -32004
    && (error.message === `Session is not active: ${id}` || error.message === "Session runtime is not ready");
}

export function isZCodeMissingSession(error: unknown, id: string): boolean {
  return error instanceof NativeRpcError && error.nativeCode === -32004
    && (error.message === `Session not found: ${id}` || error.message === `Session is not available: ${id}`);
}

/** ZCode native modes accepted by session/setMode; build asks before changes, edit auto-applies edits, yolo runs fully automatic. */
export function zcodeModeForPermission(permissionMode: ToolPermissionMode): "build" | "edit" | "yolo" {
  return permissionMode === "full-access" ? "yolo" : permissionMode === "auto-approval" ? "edit" : "build";
}

export type ZCodeHistoryDecodeOptions = ZCodeQuestionHistoryOptions;

export function decodeZCodeHistory(
  value: unknown,
  sessionId = "",
  imageData?: ReadonlyMap<string, string>,
  options: ZCodeHistoryDecodeOptions = {},
): Message[] {
  const messages: Message[] = [];
  for (const row of rows(value)) {
    const info = nativeRecord(row.info);
    const semantics = nativeRecord(info.semantics);
    if (semantics.uiVisibility === "hidden" || semantics.transcriptVisibility === "hidden") continue;
    if (info.role !== "user" && info.role !== "assistant" && info.role !== "system") continue;
    const parts = rows(row.parts);
    const text = parts.filter(part => part.type === "text").map(part => typeof part.text === "string" ? part.text : "").join("");
    const images = info.role === "user" ? parts.flatMap(part => {
      if (part.type !== "file" || typeof part.url !== "string") return [];
      const image = imageData?.get(part.url) ?? (/^data:image\/(?:jpeg|png|gif|webp);base64,/.test(part.url) ? part.url : undefined);
      return image ? [image] : [];
    }) : [];
    const messageId = info.messageId ?? info.id;
    const isSteered = info.role === "user" && nativeRecord(info.metadata).turnSteerDelivery === "guide";
    const reasoning = parts.filter(part => part.type === "reasoning" && typeof part.text === "string").map((part, index) => ({ itemId: String(part.partId ?? part.id ?? `${messageId}:reasoning:${index}`), sectionIndex: 0, text: String(part.text) }));
    const questionMessages: Message[] = [];
    let hasQuestionTool = false;
    const tools = parts.filter(part => {
      if (part.type !== "tool") return false;
      const history = zcodeQuestionHistory(part, sessionId, String(messageId ?? ""), options);
      if (history === null) return true;
      hasQuestionTool = true;
      questionMessages.push(...history);
      return false;
    });
    if (!hasQuestionTool || text || reasoning.length || tools.length || info.role !== "assistant") messages.push({ role: info.role, content: text, historyId: typeof messageId === "string" ? messageId : undefined,
      ...(isSteered ? { name: `__native_steered:${messageId}` } : {}),
      ...(images.length ? { images } : {}),
      ...(reasoning.length ? { presentation: { reasoning } } : {}),
      ...(tools.length ? { toolCalls: tools.map(part => ({ id: String(part.callId ?? part.callID ?? part.toolCallId ?? part.partId ?? part.id), name: String(part.tool ?? part.toolName ?? "ZCode tool"), arguments: nativeRecord(nativeRecord(part.state).input ?? part.input) })) } : {}),
    });
    for (const tool of tools) {
      const state = nativeRecord(tool.state);
      if (state.status !== "completed" && state.status !== "error") continue;
      messages.push({ role: "tool", toolCallId: String(tool.callId ?? tool.callID ?? tool.toolCallId ?? tool.partId ?? tool.id), content: typeof state.output === "string" ? state.output : typeof state.error === "string" ? state.error : "", isError: state.status === "error" });
    }
    messages.push(...questionMessages);
  }
  return messages;
}

/** ZCode's strict NDJSON RPC deliberately has no JSON-RPC version field. */
export class ZCodeClient implements NativeSessionProtocol {
  private readonly sessions = new Map<string, NativeProtocolSession>();
  private readonly drafts = new Map<string, NativeProtocolSession>();
  private readonly loaded = new Set<string>();
  private readonly todoMcp = new Map<string, NativeTodoMcpConfiguration>();
  private readonly resumes = new Map<string, Promise<NativeProtocolSession>>();
  private readonly historyReads = new Map<string, Promise<{ session: NativeProtocolSession; messages: Message[] }>>();
  private readonly historyCache = new Map<string, { messages: NativeJsonPacket[]; reconciledAt: number }>();
  private readonly runs = new Map<string, Run>();
  private readonly pendingTodoRuns = new Map<string, AbortController>();
  private readonly questions = new Map<string, Question>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly pendingQuestionReads = new Map<string, PendingQuestionRead>();
  private readonly interactions = new Map<string, { sessionId: string; response: Promise<NativeJsonPacket> }>();
  private models: RuntimeModelInfo[] = [];
  private readonly modelDefaults = new Map<string, ZCodeReasoningLevel>();
  private readonly childCatalog = new Map<string, { updated: string; ids: string[] }>();
  private readonly unsubscribe: Array<() => void>;
  private readonly steering: ZCodeSteering;

  // The legacy resume reply carries the whole history and the model catalog.
  constructor(private readonly rpc: NativeRpcConnection = new NativeRpcClient(() => resolveNativeCliCommand("zcode"), false, 64 * 1024 * 1024),
    private readonly activity: ZCodeActivityReader = desktopActivity,
    private readonly desktopGuide: ZCodeDesktopGuide = new ZCodeDesktopBridge(),
    private readonly imageStorageRoot = join(homedir(), ".agentroam", "zcode-images"),
    private readonly readTurnDurations: (sessionId: string) => ReadonlyMap<string, number> = readZCodeTurnDurations) {
    this.steering = new ZCodeSteering(rpc);
    rpc.onRequest((method, params) => this.callback(method, params));
    this.unsubscribe = [rpc.onNotification((method, params) => this.notification(method, params)), rpc.onFailure(error => {
      this.loaded.clear(); this.resumes.clear(); this.historyCache.clear(); this.models = []; this.modelDefaults.clear();
      this.pendingQuestionReads.clear(); this.pendingQuestions.clear();
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
      workspaceIdentity: typeof workspace.workspaceKey === "string" ? workspace.workspaceKey : previous?.workspaceIdentity,
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
        const levels = [...new Set((Array.isArray(reasoning.levels) ? reasoning.levels : []).flatMap(level => {
          const value = nativeReasoningLevel(level);
          return value ? [value] : [];
        }))];
        const efforts = levels.filter((level): level is NativeReasoningEffort => reasoningEfforts.includes(level as NativeReasoningEffort));
        const defaultEffort = nativeReasoningLevel(reasoning.defaultLevel);
        if (defaultEffort && levels.includes(defaultEffort)) this.modelDefaults.set(modelRefKey(ref.providerId, ref.modelId), defaultEffort);
        return [{ id: ref.modelId, providerID: ref.providerId, displayName: String(option.label ?? ref.modelId),
          providerDisplayName: typeof option.providerLabel === "string" ? option.providerLabel : undefined,
          description: typeof option.description === "string" ? option.description : undefined,
          ...(efforts.length ? { reasoningEfforts: efforts } : {}) }];
      });
    }
    // The session mode is enforced per turn in run() via session/setMode; snapshot projection stays out of scope.
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
        let page: NativeJsonPacket;
        try { page = await this.rpc.request("session/subagents", { sessionId: session.id, endedLimit: 100 }); }
        catch (error) {
          // session/list includes empty residents before their first input is persisted.
          if (!(error instanceof NativeRpcError) || error.nativeCode !== -32004
            || error.message !== `Session not found: ${session.id}`) throw error;
          page = {};
        }
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
    return Promise.all(sessions.map(async session => {
      const external = !this.runs.has(session.id) && (session.running || activity.get(session.id) === true);
      return { ...session,
        running: session.running || this.runs.has(session.id) || activity.get(session.id) === true,
        externalGuideSupported: external && !session.readOnly ? await this.desktopGuide.available(session) : false,
      };
    }));
  }

  private async resume(id: string, refresh = false): Promise<NativeProtocolSession> {
    const pending = this.resumes.get(id);
    if (pending) return pending;
    if (this.loaded.has(id) && !refresh) return this.sessions.get(id)!;
    const configuration = this.todoMcp.get(id);
    const loading = this.rpc.request("session/resume", { sessionId: id,
      ...(configuration ? { mcpServers: todoMcpServers(configuration) } : {}),
    }, 60_000).then(result => {
      const session = this.snapshot(result); this.loaded.add(id);
      return session;
    }).catch(error => {
      const draft = this.drafts.get(id);
      if (!draft || !isZCodeMissingSession(error, id)) throw error;
      return this.createSession(draft.cwd, draft.title, configuration, id);
    }).finally(() => {
      if (this.resumes.get(id) === loading) this.resumes.delete(id);
    });
    this.resumes.set(id, loading);
    return loading;
  }

  private async configureTodoMcp(id: string, configuration: NativeTodoMcpConfiguration | null, signal?: AbortSignal): Promise<void> {
    await this.resumes.get(id);
    signal?.throwIfAborted();
    if (this.sessions.get(id)?.readOnly) throw new RuntimeSessionError("ZCode child sessions are read-only", "SESSION_OCCUPIED");
    const previous = this.todoMcp.get(id);
    if (!configuration && !previous) return;
    if (configuration && previous && JSON.stringify(todoMcpServers(previous)) === JSON.stringify(todoMcpServers(configuration))) return;
    if (this.runs.has(id)) throw new RuntimeSessionError("ZCode session is already running", "SESSION_ALREADY_RUNNING");
    if (this.loaded.has(id)) {
      const current = this.sessions.get(id)!;
      const [observed] = await this.withDesktopActivity([current]);
      signal?.throwIfAborted();
      if (observed!.running || observed!.readOnly) throw new RuntimeSessionError("ZCode session is owned by another process", "SESSION_OCCUPIED");
      // Native resume reuses an existing resident and ignores new startup MCP
      // settings. Release only our idle resident before a configured cold resume.
      try {
        const closed = await this.rpc.request("session/close", { sessionId: id });
        if (closed.closed !== true) {
          throw new RuntimeSessionError("ZCode did not release the session for Todo MCP configuration", "NATIVE_PROTOCOL_ERROR");
        }
      } catch (error) {
        if (!isUnavailableResident(error, id)) throw error;
      }
      this.loaded.delete(id);
    }
    signal?.throwIfAborted();
    if (configuration) this.todoMcp.set(id, { command: configuration.command, args: [...configuration.args], env: { ...configuration.env } });
    else this.todoMcp.delete(id);
  }

  /** Idle eviction can report either inactive or runtime-not-ready. Never retry a send. */
  private async withActiveSession<T>(id: string, operation: (session: NativeProtocolSession) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const session = await this.resume(id);
    signal?.throwIfAborted();
    try { return await operation(session); }
    catch (error) {
      signal?.throwIfAborted();
      if (!isUnavailableResident(error, id) || this.runs.has(id)) throw error;
      this.loaded.delete(id);
      return operation(await this.resume(id));
    }
  }

  read(id: string): Promise<{ session: NativeProtocolSession; messages: Message[] }> {
    const pending = this.historyReads.get(id);
    if (pending) return pending;
    const reading = this.readHistory(id).then(detail => {
      const durations = this.readTurnDurations(id);
      if (!durations.size) return detail;
      return { ...detail, messages: detail.messages.map(message => {
        const duration = message.role === "user" && message.historyId && !message.name?.startsWith("__native_steered:")
          ? durations.get(message.historyId) : undefined;
        return duration === undefined ? message : {
          ...message, presentation: { ...message.presentation, completionDurationMs: duration },
        };
      }) };
    }).finally(() => {
      if (this.historyReads.get(id) === reading) this.historyReads.delete(id);
    });
    this.historyReads.set(id, reading);
    return reading;
  }

  private async historyBatches(id: string, cached = this.historyCache.get(id)): Promise<NativeJsonPacket[]> {
    // Refresh the mutable tail on every poll. Reconcile the complete native
    // projection periodically, and immediately if a rewind removes the cursor.
    const reusable = cached && Date.now() - cached.reconciledAt < HISTORY_RECONCILE_MS;
    const messages = reusable ? cached.messages.slice(0, -HISTORY_BATCH_SIZE) : [];
    const key = (message: NativeJsonPacket) => {
      const info = nativeRecord(message.info);
      return info.messageId ?? info.id;
    };
    const seen = new Set(messages.map(key));
    let afterMessageId = messages.length ? key(messages[messages.length - 1]) : undefined;
    while (true) {
      // Forward history can read persisted sessions without materializing a
      // resident or returning the unbounded session/resume snapshot.
      let page: NativeJsonPacket;
      try {
        page = await this.rpc.request("session/messages", { sessionId: id, direction: "forward", limit: HISTORY_BATCH_SIZE,
          ...(afterMessageId ? { afterMessageId } : {}) });
      } catch (error) {
        if (reusable && error instanceof NativeRpcError && error.message === "Message cursor is no longer available") {
          this.historyCache.delete(id);
          return this.historyBatches(id, undefined);
        }
        throw error;
      }
      if (!Array.isArray(page.messages)) throw new RuntimeSessionError("ZCode returned no history page", "NATIVE_PROTOCOL_ERROR");
      const batch = rows(page.messages);
      for (const message of batch) {
        const messageId = key(message);
        if (typeof messageId !== "string" || !messageId || seen.has(messageId)) {
          throw new RuntimeSessionError("ZCode history cursor did not advance", "NATIVE_PROTOCOL_ERROR");
        }
        seen.add(messageId); afterMessageId = messageId;
        messages.push(message);
      }
      if (batch.length < HISTORY_BATCH_SIZE) {
        this.historyCache.delete(id);
        this.historyCache.set(id, { messages, reconciledAt: reusable ? cached.reconciledAt : Date.now() });
        while (this.historyCache.size > 3) this.historyCache.delete(this.historyCache.keys().next().value!);
        return messages;
      }
    }
  }

  private async readHistorySession(id: string): Promise<NativeProtocolSession | undefined> {
    try {
      const result = await this.rpc.request("session/list", { sessionIds: [id] });
      const row = rows(result.sessions).find(entry => entry.sessionId === id);
      if (row) return this.session(row);
    } catch (error) {
      if (!(error instanceof NativeRpcError) || error.nativeCode !== -32602) throw error;
    }
    // Older versions may ignore or reject the ID filter.
    return (await this.list()).find(session => session.id === id);
  }

  private async readHistory(id: string) {
    const current = this.sessions.get(id) ?? await this.readHistorySession(id);
    if (current) {
      const [observed] = await this.withDesktopActivity([current]);
      if (observed?.externalGuideSupported && this.desktopGuide.read) {
        const snapshot = await this.desktopGuide.read(observed);
        const messages = decodeZCodeHistory(snapshot.messages, id, await readZCodeHistoryImages(snapshot.messages, this.imageStorageRoot));
        return { session: { ...this.snapshot(snapshot, false), externalGuideSupported: true }, messages };
      }
    }
    try {
      const history = await this.historyBatches(id);
      const latest = await this.readHistorySession(id) ?? current;
      if (!latest) throw new RuntimeSessionError("ZCode session not found", "SESSION_NOT_FOUND");
      const [[session], messages] = await Promise.all([this.withDesktopActivity([latest]), this.decodeSessionHistory(id, history)]);
      return { session: session!, messages };
    } catch (error) {
      const draft = this.drafts.get(id);
      if (draft && isZCodeMissingSession(error, id)) return { session: draft, messages: [] };
      // Older native versions require a resident for forward history. Preserve
      // their bounded idle recovery; unrelated protocol failures stay visible.
      if (!(error instanceof NativeRpcError) || error.nativeCode !== -32004
        || (error.message !== `Session is not active: ${id}` && error.message !== "Session runtime is not ready")) throw error;
    }
    return this.withActiveSession(id, async () => {
      const snapshot = await this.rpc.request("session/read", { sessionId: id, messageLimit: 1 });
      const history = await this.historyBatches(id);
      const [session] = await this.withDesktopActivity([this.snapshot(snapshot, false)]);
      return { session: session!, messages: await this.decodeSessionHistory(id, history, snapshot) };
    });
  }

  private async decodeSessionHistory(id: string, history: NativeJsonPacket[], snapshot?: NativeJsonPacket): Promise<Message[]> {
    if (history.length) this.drafts.delete(id);
    const images = await readZCodeHistoryImages(history, this.imageStorageRoot);
    const pending = snapshot
      ? zcodePendingQuestionsFromSnapshot(snapshot)
      : await this.readPendingQuestionState(id, history);
    const messages = decodeZCodeHistory(history, id, images, pending ? {
      includePendingQuestions: true,
      pendingInteractionIds: pending.interactionIds,
      pendingQuestionInputs: pending.inputs,
      handledQuestionToolIds: this.runs.get(id)?.handledQuestionToolIds,
    } : undefined);
    this.rememberPendingQuestions(id, pending?.interactionIds.size ? messages : []);
    return messages;
  }

  private async readPendingQuestionState(id: string, history: NativeJsonPacket[]): Promise<PendingQuestionProjection | undefined> {
    const run = this.runs.get(id);
    if (!this.loaded.has(id) && !run) return undefined;
    const toolIds = zcodePendingQuestionToolIds(history, run?.handledQuestionToolIds);
    if (toolIds.length === 0) {
      this.pendingQuestionReads.delete(id);
      return undefined;
    }
    // session/read loads the stored transcript before applying messageLimit.
    // Recheck only when an unmatched question appears or its state may be stale.
    const key = JSON.stringify(toolIds);
    const cached = this.pendingQuestionReads.get(id);
    if (cached?.key === key && Date.now() - cached.checkedAt < PENDING_QUESTION_RECHECK_MS) return cached.projection;
    const read: PendingQuestionRead = { key, checkedAt: Date.now() };
    this.pendingQuestionReads.set(id, read);
    try {
      const snapshot = await this.rpc.request("session/read", { sessionId: id, messageLimit: 1 });
      if (this.pendingQuestionReads.get(id) !== read) return undefined;
      read.projection = zcodePendingQuestionsFromSnapshot(snapshot);
      return read.projection;
    } catch {
      return undefined;
    }
  }

  private rememberPendingQuestions(sessionId: string, messages: Message[]): void {
    const active = new Set<string>();
    for (const message of messages) {
      const question = message.presentation?.question;
      if (!question || question.status !== "pending") continue;
      const interactionId = parseZCodePendingQuestionId(question.questionId);
      if (!interactionId) continue;
      active.add(question.questionId);
      this.pendingQuestions.set(question.questionId, {
        sessionId,
        interactionId,
        question: question.question,
        options: question.options,
        multiSelect: question.multiSelect,
      });
    }
    for (const [questionId, question] of this.pendingQuestions) {
      if (question.sessionId === sessionId && !active.has(questionId)) this.pendingQuestions.delete(questionId);
    }
  }

  private clearPendingInteraction(sessionId: string, interactionId: string): void {
    const projection = this.pendingQuestionReads.get(sessionId)?.projection;
    const handled = this.runs.get(sessionId)?.handledQuestionToolIds;
    for (const [toolCallId, requestId] of projection?.interactionIds ?? []) {
      if (requestId !== interactionId) continue;
      projection?.interactionIds.delete(toolCallId);
      projection?.inputs.delete(toolCallId);
      handled?.add(toolCallId);
    }
    for (const [questionId, question] of this.pendingQuestions) {
      if (question.sessionId === sessionId && question.interactionId === interactionId) this.pendingQuestions.delete(questionId);
    }
  }

  async create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession> {
    const session = await this.createSession(options.cwd, options.title, options.todoMcp);
    this.drafts.set(session.id, session);
    if (options.todoMcp) this.todoMcp.set(session.id, { command: options.todoMcp.command, args: [...options.todoMcp.args], env: { ...options.todoMcp.env } });
    return session;
  }

  private async createSession(cwd: string, title: string, todoMcp?: NativeTodoMcpConfiguration, sessionId?: string): Promise<NativeProtocolSession> {
    const result = await this.rpc.request("session/create", {
      workspace: { workspacePath: cwd, workspaceKey: cwd }, persistence: "immediate", titleGenerationEnabled: false,
      ...(sessionId ? { sessionId } : {}),
      ...(todoMcp ? { mcpServers: todoMcpServers(todoMcp) } : {}),
    }, 60_000);
    const session = this.snapshot(result);
    if (sessionId && session.id !== sessionId) throw new RuntimeSessionError("ZCode returned a different draft session ID", "NATIVE_PROTOCOL_ERROR");
    session.title = title;
    this.loaded.add(session.id);
    return session;
  }

  restoreDraft(session: NativeProtocolSession): void {
    this.drafts.set(session.id, { ...session });
    if (!this.sessions.has(session.id)) this.sessions.set(session.id, { ...session });
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    if (!this.models.length) {
      const session = (await this.list()).find(session => !session.running && !this.runs.has(session.id));
      if (session) await this.resume(session.id, true);
    }
    return [...this.models];
  }

  private async modelEffort(id: string, model: NonNullable<RuntimeRunOptions["model"]>, explicit?: NativeReasoningEffort): Promise<ZCodeReasoningLevel | undefined> {
    if (explicit) return explicit;
    const key = modelRefKey(model.providerID, model.id);
    const current = this.modelDefaults.get(key);
    if (current) return current;
    if (this.models.some(candidate => modelRefKey(candidate.providerID, candidate.id) === key)) return undefined;
    // A native RPC reconnect clears the cached catalog. Refresh the idle
    // session before sending a model-scoped turn so ZCode can apply the
    // provider's required default reasoning level.
    await this.resume(id, true);
    return this.modelDefaults.get(key);
  }

  async *run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent> {
    if (this.pendingTodoRuns.has(id)) throw new RuntimeSessionError("ZCode session is already running", "SESSION_ALREADY_RUNNING");
    const preparation = options?.todoMcp !== undefined ? new AbortController() : undefined;
    if (preparation) this.pendingTodoRuns.set(id, preparation);
    try {
      yield* this.runPrepared(id, input, images, options, preparation?.signal);
    } catch (error) {
      if (!preparation?.signal.aborted) throw error;
      yield { type: "turn_aborted" };
    } finally {
      if (this.pendingTodoRuns.get(id) === preparation) this.pendingTodoRuns.delete(id);
    }
  }

  private async *runPrepared(id: string, input: string, images?: string[], options?: RuntimeRunOptions, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const parsedImages = parseImageDataUrls(images);
    if (options?.model && !options.model.providerID) throw new RuntimeSessionError("ZCode model selection requires a native provider ID", "NATIVE_PROTOCOL_ERROR");
    if (options?.reasoningEffort && !options.model) throw new RuntimeSessionError("ZCode reasoning effort requires an explicit native model", "OPERATION_NOT_SUPPORTED");
    // Reject external desktop ownership before resume can materialize a second resident.
    const current = this.sessions.get(id) ?? (await this.list()).find(session => session.id === id)
      ?? { id, title: "ZCode", cwd: "", created: "", updated: "" };
    const [observed] = await this.withDesktopActivity([current]);
    signal?.throwIfAborted();
    if (observed!.running && !this.runs.has(id)) {
      if (options?.todoMcp) throw new RuntimeSessionError("ZCode 桌面端运行中的原会话无法注入会话隔离的待办 MCP，请等待任务结束后重试", "OPERATION_NOT_SUPPORTED");
      if (!observed!.externalGuideSupported || observed!.readOnly) throw new RuntimeSessionError("ZCode session is owned by another process", "SESSION_OCCUPIED");
      if (parsedImages.length) throw new RuntimeSessionError("ZCode 桌面端运行中的原会话仅支持文字引导，请等待任务结束后发送图片", "OPERATION_NOT_SUPPORTED");
      if (options?.goal) throw new RuntimeSessionError("桌面端原会话仅支持文字引导", "OPERATION_NOT_SUPPORTED");
      await this.desktopGuide.steer(observed!, input, options?.brokerRunId);
      yield { type: "runtime_progress", progressId: "zcode-desktop-guide", phase: "status", label: "已交给桌面端原会话", detail: "补充消息已接收，原任务继续执行。" };
      yield { type: "done", finalText: "" };
      return;
    }
    if (options?.todoMcp !== undefined) await this.configureTodoMcp(id, options.todoMcp, signal);
    signal?.throwIfAborted();
    let effort: ZCodeReasoningLevel | undefined;
    const subscribed = await this.withActiveSession(id, async session => {
      signal?.throwIfAborted();
      const [observed] = await this.withDesktopActivity([session]);
      signal?.throwIfAborted();
      if (observed!.running && !this.runs.has(id)) throw new RuntimeSessionError("ZCode session is owned by another process", "SESSION_OCCUPIED");
      if (this.runs.has(id)) throw new RuntimeSessionError("ZCode session is already running", "SESSION_ALREADY_RUNNING");
      // Arm the unified permission gate before the turn: a silent failure here could run a gated turn fully automatic.
      if (options?.permissionMode) await this.applySessionMode(id, zcodeModeForPermission(options.permissionMode));
      if (options?.model) effort = await this.modelEffort(id, options.model, options.reasoningEffort);
      signal?.throwIfAborted();
      return this.rpc.request("session/subscribe", { sessionId: id, deliveryKind: "web-remote-replayable", includeSnapshot: false });
    }, signal);
    signal?.throwIfAborted();
    const attachments = await persistZCodeImageAttachments(parsedImages, this.imageStorageRoot);
    signal?.throwIfAborted();
    const run: Run = {
      queue: new AsyncEventQueue(), text: "", aborted: false, finished: false,
      lastSeq: typeof subscribed.eventSeq === "number" ? subscribed.eventSeq : 0,
      toolIds: new Set(), handledQuestionToolIds: new Set(), reasoningId: randomUUID(),
    };
    this.runs.set(id, run);
    if (this.pendingTodoRuns.get(id)?.signal === signal) this.pendingTodoRuns.delete(id);
    try {
      // The broker run ID is stable for the lifetime of one admitted turn. ZCode
      // uses inputId as its durable command identity, so reusing it lets a
      // transport retry be acknowledged without creating another history row.
      const inputId = options?.brokerRunId ?? randomUUID();
      const accepted = await this.rpc.request("session/send", { sessionId: id, inputId, content: input,
        ...(attachments.length ? { attachments } : {}),
        ...(options?.model ? { modelSelection: { providerId: options.model.providerID, modelId: options.model.id,
          ...(effort ? { options: { reasoningLevel: effort } } : {}) } } : {}),
      });
      if (accepted.accepted !== true) throw new RuntimeSessionError("ZCode did not accept the native turn", "NATIVE_PROTOCOL_ERROR");
      yield* run.queue;
    } finally {
      if (!run.finished) await this.abort(id);
      this.runs.delete(id); this.cancelQuestions(id);
      for (const [key, interaction] of this.interactions) if (interaction.sessionId === id) this.interactions.delete(key);
      this.steering.clearSession(id);
      run.queue.close();
    }
  }

  /** A turn must not start unless the requested native permission mode was applied. */
  private async applySessionMode(id: string, mode: "build" | "edit" | "yolo"): Promise<void> {
    try { await this.rpc.request("session/setMode", { sessionId: id, mode }); }
    catch (error) {
      if (error instanceof NativeRpcError && error.nativeCode === -32601) {
        throw new RuntimeSessionError("当前 ZCode 版本不支持设置会话权限，请升级 ZCode 后重试", "OPERATION_NOT_SUPPORTED");
      }
      throw error;
    }
  }

  private finish(id: string, event: AgentEvent): void {
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    if (event.type === "done") this.drafts.delete(id);
    this.pendingQuestionReads.delete(id);
    this.rememberPendingQuestions(id, []);
    this.cancelQuestions(id); run.finished = true; run.queue.push(event); run.queue.close();
    const session = this.sessions.get(id); if (session) session.running = false;
  }

  private notification(method: string, params: NativeJsonPacket): void {
    if (method !== "session/event" || typeof params.sessionId !== "string") return;
    const run = this.runs.get(params.sessionId);
    if (!run || run.finished) return;
    if (typeof params.seq === "number") { if (params.seq <= run.lastSeq) return; run.lastSeq = params.seq; }
    const payload = nativeRecord(params.payload);
    if (params.type === "permission.resolved" && typeof payload.toolCallId === "string") {
      const projection = this.pendingQuestionReads.get(params.sessionId)?.projection;
      const interactionId = projection?.interactionIds.get(payload.toolCallId);
      if (interactionId || isZCodeQuestionTool(payload.toolName)) {
        run.handledQuestionToolIds.add(payload.toolCallId);
        const requestId = interactionId ?? (typeof payload.requestId === "string" ? payload.requestId : undefined);
        if (requestId) this.clearPendingInteraction(params.sessionId, requestId);
      }
    } else if (params.type === "session.updated") {
      const progress = zcodeModelProgress(payload);
      if (progress) run.queue.push(progress);
    } else if (params.type === "model.streaming") {
      if (payload.kind === "text_delta" && typeof payload.delta === "string") {
        run.text += payload.delta;
        if (payload.delta.trim()) {
          run.finalMessageId = typeof payload.assistantMessageId === "string" && payload.assistantMessageId.trim()
            ? payload.assistantMessageId : undefined;
        }
        run.queue.push({ type: "text_chunk", text: payload.delta, turnId: typeof params.turnId === "string" ? params.turnId : undefined });
      }
      else if (payload.kind === "reasoning_delta" && typeof payload.delta === "string") run.queue.push({ type: "reasoning_summary_delta", itemId: String(payload.partId ?? params.turnId ?? run.reasoningId), sectionIndex: 0, delta: payload.delta });
      else if (payload.kind === "tool_call" && typeof payload.toolCallId === "string" && !run.toolIds.has(payload.toolCallId)) {
        run.finalMessageId = undefined;
        run.toolIds.add(payload.toolCallId);
        if (!isZCodeQuestionTool(payload.toolName)) run.queue.push({ type: "tool_call", toolCall: { id: payload.toolCallId, name: String(payload.toolName ?? "ZCode tool"), arguments: nativeRecord(payload.input) } });
      }
    } else if (params.type === "tool.updated" && typeof payload.toolCallId === "string") {
      if ((payload.kind === "scheduled" || payload.kind === "started") && !run.toolIds.has(payload.toolCallId)) {
        run.finalMessageId = undefined;
        run.toolIds.add(payload.toolCallId);
        if (!isZCodeQuestionTool(payload.toolName)) run.queue.push({ type: "tool_call", toolCall: { id: payload.toolCallId, name: String(payload.toolName ?? "ZCode tool"), arguments: nativeRecord(payload.input) } });
      } else if (payload.kind === "result" || payload.kind === "error") run.queue.push({ type: "tool_result", result: { toolCallId: payload.toolCallId, content: typeof payload.output === "string" ? payload.output : typeof payload.result === "string" ? payload.result : String(nativeRecord(payload.error).message ?? ""), isError: payload.kind === "error" } });
    } else if (params.type === "turn.completed") {
      const durationMs = typeof payload.duration === "number" && Number.isFinite(payload.duration) && payload.duration >= 0
        ? payload.duration : undefined;
      this.finish(params.sessionId, run.aborted || payload.resultType === "cancelled" ? {
        type: "turn_aborted", ...(durationMs === undefined ? {} : { durationMs }),
      } : {
        type: "done",
        finalText: run.text,
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(run.finalMessageId ? { forkPoint: { messageId: run.finalMessageId } } : {}),
      });
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
    if (!run || run.finished) return cancelled;
    const input = rows(params.questions);
    if (method === "interaction/requestUserInput" && (!input.length
      || input.some(question => typeof question.question !== "string" || !question.question.trim()))) {
      return { action: "decline", reason: "This input form is not supported" };
    }
    const id = zcodeInteractionId(method, params);
    const previous = this.interactions.get(id);
    if (previous) return previous.response;
    if (method === "interaction/requestUserInput" && typeof params.toolCallId === "string") {
      run.handledQuestionToolIds.add(params.toolCallId);
    }
    const response = new Promise<NativeJsonPacket>(resolve => {
      const inputs = method === "interaction/requestUserInput" ? input : [undefined];
      const ids = inputs.map((_, index) => inputs.length === 1 ? id : `${id}:${index}`);
      const answers: Record<string, unknown> = {};
      let remaining = inputs.length;
      let settled = false;
      const settle = (result: NativeJsonPacket) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        for (const questionId of ids) {
          if (!this.questions.delete(questionId)) continue;
          run.queue.push({ type: "approval_resolved", questionId });
        }
        resolve(result);
      };
      const timer = setTimeout(() => settle(cancelled), 10 * 60_000); timer.unref?.();
      inputs.forEach((inputQuestion, index) => {
        const questionId = ids[index];
        const options = rows(inputQuestion ? inputQuestion.options : params.options);
        this.questions.set(questionId, { sessionId, options, cancelled, inputQuestion: inputQuestion ? String(inputQuestion.question) : undefined,
          multiSelect: inputQuestion?.multiSelect === true,
          resolve: result => {
            if (!inputQuestion || result.action !== "accept") { settle(result); return; }
            Object.assign(answers, nativeRecord(nativeRecord(result.content).answers));
            if (--remaining === 0) settle({ action: "accept", content: { answers } });
          } });
        run.queue.push({ type: "ask_user", questionId,
          question: inputQuestion ? String(inputQuestion.question) : `${String(params.toolName ?? "ZCode tool")}: ${String(params.reason ?? "Permission requested")}`,
          options: options.length ? options.map(option => ({ label: String(option.label ?? option.name ?? option.value ?? option.optionId), description: typeof option.description === "string" ? option.description : String(option.kind ?? "") })) : undefined,
          ...(inputQuestion ? { multiSelect: inputQuestion.multiSelect === true } : {}) });
      });
    });
    this.interactions.set(id, { sessionId, response });
    return response;
  }

  private resolveQuestion(id: string, result: NativeJsonPacket): void {
    const pending = this.questions.get(id);
    if (!pending) return;
    this.questions.delete(id); pending.resolve(result);
    this.runs.get(pending.sessionId)?.queue.push({ type: "approval_resolved", questionId: id });
  }

  private cancelQuestions(sessionId: string): void { for (const [id, pending] of this.questions) if (pending.sessionId === sessionId) this.resolveQuestion(id, pending.cancelled); }

  async answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    const pendingSnapshot = this.pendingQuestions.get(id);
    if (pendingSnapshot) return this.resolvePendingQuestion(pendingSnapshot, answer);
    const pending = this.questions.get(id);
    if (!pending) return false;
    const index = answer.selectedIndices?.length === 1 ? answer.selectedIndices[0] : pending.options.findIndex(option => option.optionId === answer.answer || option.name === answer.answer || option.label === answer.answer || option.value === answer.answer);
    const option = pending.options[index];
    if (pending.inputQuestion) {
      const selected = answer.selectedIndices;
      if (selected?.some(index => !Number.isInteger(index) || index < 0 || index >= pending.options.length)
        || (!pending.multiSelect && selected && selected.length > 1)) {
        throw new RuntimeSessionError("Select valid native question options", "QUESTION_ANSWER_FAILED");
      }
      const text = selected?.length
        ? [...new Set(selected)].map(index => String(pending.options[index].value ?? pending.options[index].label)).join(", ")
        : option ? String(option.value ?? option.label) : answer.answer;
      this.resolveQuestion(id, { action: "accept", content: { answers: { [pending.inputQuestion]: text } } });
    } else {
      const response = nativeRecord(option?.response);
      if (!option || typeof response.decision !== "string") throw new RuntimeSessionError("Select a native permission option", "QUESTION_ANSWER_FAILED");
      this.resolveQuestion(id, response);
    }
    return true;
  }

  private async resolvePendingQuestion(pending: PendingQuestion, answer: RuntimeQuestionAnswer): Promise<boolean> {
    const selected = answer.selectedIndices;
    if (selected?.some(index => !Number.isInteger(index) || index < 0 || index >= pending.options.length)
      || (!pending.multiSelect && selected && selected.length > 1)) {
      throw new RuntimeSessionError("Select valid native question options", "QUESTION_ANSWER_FAILED");
    }
    const option = selected?.length
      ? [...new Set(selected)].map(index => pending.options[index]!.label).join(", ")
      : answer.answer;
    if (!option?.trim()) return false;
    const key = JSON.stringify([pending.sessionId, pending.interactionId, pending.question, option]);
    const commandId = "agentroam-question:" + createHash("sha256").update(key).digest("hex");
    const envelope = {
      commandId,
      clientId: "agentroam",
      sessionId: pending.sessionId,
      type: "resolveInteraction",
      payload: {
        interactionId: pending.interactionId,
        answer: { action: "accept", content: { answers: { [pending.question]: option } } },
      },
      issuedAt: Date.now(),
    };
    let ack: NativeJsonPacket;
    try {
      ack = await this.rpc.request("v4/command", envelope);
    } catch {
      ack = await this.rpc.request("v4/commands/query", { commands: [{ sessionId: pending.sessionId, commandId }] });
      const result = rows(ack.results).find(row => nativeRecord(row.key).commandId === commandId)?.result;
      if (!result || result === "unknown") throw new RuntimeSessionError("ZCode 未确认问题回答，原问题仍保留", "NATIVE_PROTOCOL_ERROR");
      ack = nativeRecord(result);
    }
    if (ack.commandId !== commandId || !["accepted", "duplicate", "noop"].includes(String(ack.status))) {
      throw new RuntimeSessionError("ZCode 未确认问题回答，原问题仍保留", "NATIVE_PROTOCOL_ERROR");
    }
    this.clearPendingInteraction(pending.sessionId, pending.interactionId);
    return true;
  }

  async abort(id: string): Promise<void> {
    this.pendingTodoRuns.get(id)?.abort();
    const run = this.runs.get(id);
    if (!run || run.finished) return;
    run.aborted = true; this.cancelQuestions(id);
    await this.rpc.request("session/stop", { sessionId: id });
    this.finish(id, { type: "turn_aborted" });
  }

  async steer(id: string, input: string, messageId?: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run) {
      const session = this.sessions.get(id);
      return session && !session.readOnly && input.trim() && await this.desktopGuide.available(session)
        ? this.desktopGuide.steer(session, input, messageId) : false;
    }
    if (run.finished || run.aborted || !input.trim()) return Promise.resolve(false);
    return this.steering.steer(id, input, messageId);
  }

  async dispose(): Promise<void> {
    for (const preparation of this.pendingTodoRuns.values()) preparation.abort();
    this.pendingTodoRuns.clear();
    for (const id of this.runs.keys()) { this.cancelQuestions(id); this.steering.clearSession(id); }
    this.interactions.clear();
    this.pendingQuestionReads.clear();
    this.pendingQuestions.clear();
    this.todoMcp.clear();
    await this.rpc.dispose();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }
}
