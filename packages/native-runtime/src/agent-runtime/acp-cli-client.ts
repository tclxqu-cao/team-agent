import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readPromptAttachments, type AgentEvent } from "@agent/core";
import { acpChoices, acpConfig, acpModels, acpReasoningEffort, acpRecords, AcpSessionProjection } from "./acp-session-projection.js";
import { readAcpQuestion, type AcpQuestionCard } from "./acp-questions.js";
import { AcpAttachmentStore, acpAttachmentBlocks } from "./acp-attachments.js";
import { AsyncEventQueue } from "./async-event-queue.js";
import { parseImageDataUrls } from "./image-input.js";
import { resolveNativeCliCommand } from "./native-cli-command.js";
import { NativeRpcClient, nativeRecord, type NativeRpcConnection } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { RuntimeSessionError, type CreateRuntimeSessionOptions, type NativeSessionPermissions, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";

export const ACP_CLI_LABELS = { grok: "Grok CLI", agy: "Antigravity CLI" } as const;
export type AcpCliAgentType = keyof typeof ACP_CLI_LABELS;
const SESSION_TIMEOUT_MS = 45_000;
const CATALOG_TIMEOUT_MS = 8_000;

interface ResidentSession {
  projection: AcpSessionProjection;
  config: NativeJsonPacket;
}

interface AcpTurn {
  queue: AsyncEventQueue<AgentEvent>;
  projection: AcpSessionProjection;
  aborted: boolean;
  prompting: boolean;
  text: string;
  userTurnIndex?: number;
}

interface AcpPermission {
  sessionId: string;
  options: NativeJsonPacket[];
  settle(outcome: NativeJsonPacket): void;
}

interface PendingAcpQuestion {
  sessionId: string;
  group: symbol;
  card: AcpQuestionCard;
  settle(answer?: { value: unknown; text: string }): void;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function modeOptions(config: NativeJsonPacket): NativeSessionPermissions | undefined {
  const selector = acpConfig(config, "mode");
  const modes = nativeRecord(config.modes);
  const currentValue = selector?.currentValue ?? modes.currentModeId;
  if (typeof currentValue !== "string") return undefined;
  const options = selector ? acpChoices(selector) : acpRecords(modes.availableModes);
  return { currentValue, options: options.flatMap(option => {
    const value = option.value ?? option.id;
    return typeof value === "string" ? [{ value, label: typeof option.name === "string" ? option.name : value,
      description: typeof option.description === "string" ? option.description : undefined }] : [];
  }) };
}

/** ACP anti-corruption layer; native session IDs, permissions and credentials stay with the CLI. */
export class AcpCliClient implements NativeSessionProtocol {
  private initialization?: Promise<void>;
  private checking?: Promise<void>;
  private checkedUntil = 0;
  private readonly sessions = new Map<string, NativeProtocolSession>();
  private readonly residents = new Map<string, ResidentSession>();
  private readonly loading = new Map<string, Promise<ResidentSession>>();
  private readonly turns = new Map<string, AcpTurn>();
  private readonly permissions = new Map<string, AcpPermission>();
  private readonly questions = new Map<string, PendingAcpQuestion>();
  private readonly unsubscribe: Array<() => void>;
  private models: RuntimeModelInfo[] = [];
  private imageSupported = false;
  private embeddedContextSupported = false;
  private disposed = false;
  private readonly localFiles?: AcpAttachmentStore;
  private readonly rpc: NativeRpcConnection;

  constructor(
    readonly agentType: AcpCliAgentType,
    connection?: NativeRpcConnection,
  ) {
    this.localFiles = agentType === "agy" ? new AcpAttachmentStore() : undefined;
    const rpc = this.rpc = connection ?? new NativeRpcClient(async () => {
      const cli = await resolveNativeCliCommand(agentType);
      const args = this.localFiles ? [...(cli.args ?? []), "--add-dir", await this.localFiles.root()] : cli.args;
      return { ...cli, args, cwd: homedir() };
    });
    this.unsubscribe = [
      rpc.onNotification((method, params) => this.notification(method, params)),
      rpc.onFailure(() => {
        this.initialization = undefined;
        this.checkedUntil = 0;
        this.residents.clear();
        this.models = [];
        for (const id of this.turns.keys()) this.cancelInteractions(id);
      }),
    ];
    rpc.onRequest((method, params) => this.callback(method, params));
  }

  private get label(): string { return ACP_CLI_LABELS[this.agentType]; }

  available(): Promise<void> {
    if (Date.now() < this.checkedUntil) return Promise.resolve();
    return this.checking ??= this.connect().then(async () => {
      // An ACP handshake can succeed before the CLI has usable account access.
      await this.listPage();
      this.checkedUntil = Date.now() + 60_000;
    }).finally(() => { this.checking = undefined; });
  }

  async getCapabilities(): Promise<import("@agent/core").RuntimeCapabilities> {
    await this.available();
    return { promptFileAttachments: this.embeddedContextSupported, nativePermissionPresets: true };
  }

  private connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new RuntimeSessionError(`${this.label} is disposed`, "RUNTIME_UNAVAILABLE"));
    return this.initialization ??= this.rpc.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "agentroam", version: "1" },
      clientCapabilities: this.agentType === "agy" ? { elicitation: { form: {} } } : {},
    }).then(result => {
      if (result.protocolVersion !== 1) {
        throw new RuntimeSessionError(`${this.label} requires ACP protocol version 1`, "RUNTIME_UNAVAILABLE");
      }
      const capabilities = nativeRecord(result.agentCapabilities);
      const catalog = nativeRecord(capabilities.sessionCapabilities);
      const prompt = nativeRecord(capabilities.promptCapabilities);
      this.imageSupported = prompt.image === true;
      this.embeddedContextSupported = prompt.embeddedContext === true;
      if (!("list" in catalog) || !(capabilities.loadSession === true || "load" in catalog)) {
        throw new RuntimeSessionError(`${this.label} requires ACP session discovery and history support`, "RUNTIME_UNAVAILABLE");
      }
      this.models = acpModels(result);
    }).catch(error => { this.initialization = undefined; throw error; });
  }

  private captureSession(row: NativeJsonPacket): NativeProtocolSession {
    const id = row.sessionId;
    if (typeof id !== "string" || !id) throw new RuntimeSessionError(`${this.label} returned no session ID`, "NATIVE_PROTOCOL_ERROR");
    const previous = this.sessions.get(id);
    const updated = isoTime(row.updatedAt) ?? previous?.updated ?? new Date().toISOString();
    const session = {
      ...previous, id,
      title: typeof row.title === "string" && row.title.trim() ? row.title : previous?.title || this.label,
      cwd: typeof row.cwd === "string" && row.cwd ? row.cwd : previous?.cwd ?? "",
      created: previous?.created ?? isoTime(row.createdAt) ?? updated,
      updated: previous && previous.updated > updated ? previous.updated : updated,
    };
    this.sessions.set(id, session);
    return session;
  }

  private listPage(cursor?: string): Promise<NativeJsonPacket> {
    return this.rpc.request("session/list", cursor ? { cursor } : {}, CATALOG_TIMEOUT_MS);
  }

  async list(): Promise<NativeProtocolSession[]> {
    await this.connect();
    const cursors = new Set<string>();
    const discovered = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.listPage(cursor);
      for (const row of acpRecords(page.sessions)) {
        if (typeof row.sessionId === "string" && row.sessionId) discovered.add(this.captureSession(row).id);
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      if (cursor && (cursors.has(cursor) || cursors.size >= 100)) {
        throw new RuntimeSessionError(`${this.label} session pagination did not terminate`, "NATIVE_PROTOCOL_ERROR");
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    for (const id of this.residents.keys()) discovered.add(id);
    return [...discovered].map(id => this.sessions.get(id)!);
  }

  private async open(id: string): Promise<ResidentSession> {
    const resident = this.residents.get(id);
    if (resident) return resident;
    const pending = this.loading.get(id);
    if (pending) return pending;
    const operation = this.load(id);
    this.loading.set(id, operation);
    try { return await operation; }
    finally { this.loading.delete(id); }
  }

  private async load(id: string): Promise<ResidentSession> {
    await this.connect();
    if (!this.sessions.has(id)) await this.list();
    const session = this.sessions.get(id);
    if (!session?.cwd) throw new RuntimeSessionError(`${this.label} session not found`, "SESSION_NOT_FOUND");
    const projection = new AcpSessionProjection();
    const unsubscribe = this.rpc.onNotification((method, params) => {
      if (method === "session/update" && params.sessionId === id) projection.update(nativeRecord(params.update));
    });
    try {
      const config = await this.rpc.request("session/load", { sessionId: id, cwd: session.cwd, mcpServers: [] }, SESSION_TIMEOUT_MS);
      projection.finishTurn();
      const result = { projection, config };
      this.residents.set(id, result);
      this.captureConfig(id, result, config);
      return result;
    } finally { unsubscribe(); }
  }

  async read(id: string) {
    const { projection } = await this.open(id);
    return { session: this.sessions.get(id)!, messages: structuredClone(projection.messages) };
  }

  async create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession> {
    await this.connect();
    const cwd = resolve(options.cwd || homedir());
    const config = await this.rpc.request("session/new", { cwd, mcpServers: [] }, SESSION_TIMEOUT_MS);
    const now = new Date().toISOString();
    const session = this.captureSession({ sessionId: config.sessionId, title: options.title, cwd, updatedAt: now });
    const resident = { projection: new AcpSessionProjection(), config };
    this.residents.set(session.id, resident);
    this.captureConfig(session.id, resident, config);
    return session;
  }

  async listModels(): Promise<RuntimeModelInfo[]> {
    await this.connect();
    return this.models;
  }

  private captureConfig(id: string, resident: ResidentSession, config: NativeJsonPacket): void {
    resident.config = { ...resident.config, ...config };
    const models = acpModels(resident.config);
    if (models.length) this.models = models;
    const session = this.sessions.get(id);
    if (session) session.nativePermissions = modeOptions(resident.config) ?? (this.agentType === "grok" ? {
      currentValue: session.nativePermissions?.currentValue ?? "default",
      options: [
        { value: "default", label: "默认", description: "工具审批遵循 Grok CLI 当前规则" },
        { value: "plan", label: "计划", description: "先规划，使用 Grok 的原生计划模式" },
      ],
    } : undefined);
  }

  private async setConfig(id: string, resident: ResidentSession, category: string, value: string): Promise<boolean> {
    const selector = acpConfig(resident.config, category);
    if (!selector) return false;
    const choice = acpChoices(selector).find(option => category === "thought_level" ? acpReasoningEffort(option.value) === value : option.value === value);
    if (!choice) {
      throw new RuntimeSessionError(`${this.label} does not offer ${category} ${value}`, "OPERATION_NOT_SUPPORTED");
    }
    if (selector.currentValue === choice.value) return true;
    const result = await this.rpc.request("session/set_config_option", { sessionId: id, configId: selector.id, value: choice.value });
    this.captureConfig(id, resident, result);
    return true;
  }

  async setMode(id: string, mode: string): Promise<void> {
    const resident = await this.open(id);
    const current = this.sessions.get(id)?.nativePermissions;
    if (!current?.options.some(option => option.value === mode)) {
      throw new RuntimeSessionError(`${this.label} does not offer permission mode ${mode}`, "OPERATION_NOT_SUPPORTED");
    }
    if (await this.setConfig(id, resident, "mode", mode) || current.currentValue === mode) return;
    await this.rpc.request("session/set_mode", { sessionId: id, modeId: mode });
    this.captureConfig(id, resident, { modes: {
      ...nativeRecord(resident.config.modes), currentModeId: mode,
      availableModes: current.options.map(option => ({ id: option.value, name: option.label, description: option.description })),
    } });
  }

  async *run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent> {
    if (this.turns.has(id)) throw new RuntimeSessionError("Native session is already running", "SESSION_ALREADY_RUNNING");
    const turn: AcpTurn = {
      queue: new AsyncEventQueue(), projection: new AcpSessionProjection(), aborted: false, prompting: false, text: "",
    };
    this.turns.set(id, turn);
    try {
      const resident = await this.open(id);
      if (turn.aborted) { yield { type: "turn_aborted" }; return; }
      if (images?.length && !this.imageSupported) throw new RuntimeSessionError(`${this.label} does not accept images`, "OPERATION_NOT_SUPPORTED");
      const attachments = readPromptAttachments(options?.attachments) ?? [];
      if (attachments.length && !this.embeddedContextSupported) {
        throw new RuntimeSessionError(`${this.label} does not accept file attachments`, "OPERATION_NOT_SUPPORTED");
      }
      const prompt: NativeJsonPacket[] = [{ type: "text", text: input }, ...parseImageDataUrls(images).map(image => ({
        type: "image", mimeType: image.mimeType, data: image.base64,
      })), ...await acpAttachmentBlocks(attachments, this.localFiles)];
      if (options?.model && !await this.setConfig(id, resident, "model", options.model.id)) {
        await this.rpc.request("session/set_model", { sessionId: id, modelId: options.model.id });
      }
      if (options?.reasoningEffort && !await this.setConfig(id, resident, "thought_level", options.reasoningEffort)) {
        throw new RuntimeSessionError(`${this.label} does not expose reasoning effort`, "OPERATION_NOT_SUPPORTED");
      }
      if (turn.aborted) { yield { type: "turn_aborted" }; return; }
      turn.userTurnIndex = resident.projection.messages.filter(message => message.role === "user").length;
      turn.projection.appendUser(input, images);
      turn.prompting = true;
      const completion = this.prompt(id, resident, turn, prompt);
      try { yield* turn.queue; }
      finally {
        if (turn.prompting) await this.abort(id).catch(() => undefined);
        await completion;
      }
    } catch (error) {
      if (turn.aborted) yield { type: "turn_aborted" };
      else throw error;
    } finally {
      this.turns.delete(id);
    }
  }

  private async prompt(id: string, resident: ResidentSession, turn: AcpTurn, prompt: NativeJsonPacket[]): Promise<void> {
    try {
      const result = await this.rpc.request("session/prompt", { sessionId: id, prompt }, 15 * 60_000);
      this.cancelInteractions(id);
      if (turn.aborted || result.stopReason === "cancelled") turn.queue.push({ type: "turn_aborted" });
      else if (["end_turn", "max_tokens", "max_turn_requests", "refusal"].includes(String(result.stopReason))) {
        turn.queue.push({ type: "done", finalText: turn.text });
      } else {
        throw new RuntimeSessionError(`${this.label} returned an invalid prompt stop reason`, "NATIVE_PROTOCOL_ERROR");
      }
    } catch (error) {
      if (!turn.aborted && this.residents.get(id) === resident) {
        await this.rpc.notify("session/cancel", { sessionId: id }).catch(() => undefined);
      }
      this.cancelInteractions(id);
      turn.queue.push(turn.aborted ? { type: "turn_aborted" } : {
        type: "error", message: error instanceof Error ? error.message : `${this.label} prompt failed`,
        ...(error instanceof RuntimeSessionError ? { code: error.code } : {}),
      });
    } finally {
      turn.prompting = false;
      this.cancelInteractions(id);
      // The broker overlays live events onto the completed transcript when clients reconnect mid-turn.
      // Commit this turn before the queue releases its terminal event.
      for (const message of turn.projection.messages) resident.projection.messages.push(message);
      const session = this.sessions.get(id);
      if (session) session.updated = new Date().toISOString();
      turn.queue.close();
    }
  }

  async abort(id: string): Promise<void> {
    const turn = this.turns.get(id);
    if (!turn || turn.aborted) return;
    turn.aborted = true;
    this.cancelInteractions(id);
    if (turn.prompting) await this.rpc.notify("session/cancel", { sessionId: id });
  }

  private notification(method: string, params: NativeJsonPacket): void {
    if (method !== "session/update" || typeof params.sessionId !== "string") return;
    const id = params.sessionId;
    const update = nativeRecord(params.update);
    const resident = this.residents.get(id);
    if (update.sessionUpdate === "session_info_update") this.captureSession({ ...update, sessionId: id });
    if (resident && update.sessionUpdate === "config_option_update") this.captureConfig(id, resident, { configOptions: update.configOptions });
    if (resident && update.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") {
      this.captureConfig(id, resident, { modes: { ...nativeRecord(resident.config.modes), currentModeId: update.currentModeId } });
    }
    const turn = this.turns.get(id);
    if (!turn?.prompting || !resident) return;
    for (const event of turn.projection.update(update, true)) {
      if (event.type === "text_chunk") turn.text += event.text;
      turn.queue.push(event);
    }
  }

  private async callback(method: string, params: NativeJsonPacket): Promise<unknown> {
    const sessionId = String(params.sessionId ?? "");
    const turn = this.turns.get(sessionId);
    if (method !== "session/request_permission") {
      const request = readAcpQuestion(this.agentType, method, params);
      if (!request) throw new Error("Unsupported ACP callback");
      if (!turn?.prompting || turn.aborted || !request.cards.length) return request.cancel;
      const toolCallId = typeof params.toolCallId === "string" ? params.toolCallId : undefined;
      const group = Symbol();
      const answers = await Promise.all(request.cards.map(card => this.ask(sessionId, turn, card, group, toolCallId)));
      return answers.some(answer => answer.cancelled) ? request.cancel : request.reply(answers.map(answer => answer.value));
    }
    const options = acpRecords(params.options).filter(option => typeof option.optionId === "string");
    if (!turn?.prompting || turn.aborted || !options.length) return { outcome: { outcome: "cancelled" } };
    const id = `acp-permission:${randomUUID()}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.settlePermission(id, { outcome: "cancelled" }), 10 * 60_000);
      timer.unref?.();
      this.permissions.set(id, { sessionId, options, settle: outcome => { clearTimeout(timer); resolve({ outcome }); } });
      turn.queue.push({
        type: "ask_user", questionId: id, question: String(nativeRecord(params.toolCall).title ?? `${this.label} requests permission`),
        options: options.map(option => ({ label: String(option.name ?? option.optionId), description: String(option.kind ?? "") })),
      });
    });
  }

  private ask(sessionId: string, turn: AcpTurn, card: AcpQuestionCard, group: symbol, toolCallId?: string): Promise<{ value: unknown; cancelled: boolean }> {
    const id = `acp-question:${randomUUID()}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => this.finishQuestion(id), 10 * 60_000);
      timer.unref?.();
      this.questions.set(id, {
        sessionId, card, group,
        settle: answer => {
          clearTimeout(timer);
          const question = { ...card.display, options: card.display.options ?? [], multiSelect: card.display.multiSelect ?? false,
            questionId: id, status: answer ? "answered" as const : "cancelled" as const, answer: answer?.text };
          turn.projection.messages.push({
            role: "assistant", content: "",
            presentation: { question },
          });
          turn.queue.push({ type: "approval_resolved", questionId: id, resolvedQuestion: question, toolCallId, userTurnIndex: turn.userTurnIndex });
          resolve({ value: answer?.value, cancelled: !answer });
        },
      });
      turn.queue.push({ type: "ask_user", questionId: id, cancellable: true, ...card.display });
    });
  }

  private finishQuestion(id: string, answer?: { value: unknown; text: string }): void {
    const question = this.questions.get(id);
    if (!question) return;
    this.questions.delete(id);
    question.settle(answer);
  }

  private settlePermission(id: string, outcome: NativeJsonPacket): void {
    const permission = this.permissions.get(id);
    if (!permission) return;
    this.permissions.delete(id);
    permission.settle(outcome);
    this.turns.get(permission.sessionId)?.queue.push({ type: "approval_resolved", questionId: id });
  }

  private cancelInteractions(sessionId: string): void {
    for (const [id, permission] of this.permissions) {
      if (permission.sessionId === sessionId) this.settlePermission(id, { outcome: "cancelled" });
    }
    for (const [id, question] of this.questions) {
      if (question.sessionId === sessionId) this.finishQuestion(id);
    }
  }

  async answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    const question = this.questions.get(id);
    if (question) {
      if (answer.selectedIndices?.length === 1 && answer.selectedIndices[0] === -1) {
        for (const [pendingId, pending] of this.questions) if (pending.group === question.group) this.finishQuestion(pendingId);
        return true;
      }
      const resolved = question.card.answer(answer);
      this.finishQuestion(id, resolved ?? { value: undefined, text: "已跳过" });
      return true;
    }
    const permission = this.permissions.get(id);
    if (!permission) return false;
    const option = answer.selectedIndices?.length === 1
      ? permission.options[answer.selectedIndices[0]]
      : permission.options.find(option => option.optionId === answer.answer || option.name === answer.answer);
    if (!option) throw new RuntimeSessionError("Select a native permission option", "QUESTION_ANSWER_FAILED");
    this.settlePermission(id, { outcome: "selected", optionId: option.optionId });
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.checkedUntil = 0;
    for (const id of this.turns.keys()) this.cancelInteractions(id);
    try { await this.rpc.dispose(); }
    finally {
      for (const unsubscribe of this.unsubscribe) unsubscribe();
      this.residents.clear();
      await this.localFiles?.dispose();
    }
  }
}
