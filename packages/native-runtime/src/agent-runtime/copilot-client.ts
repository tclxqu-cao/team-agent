import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentEvent } from "@agent/core";
import { ActionType, MessageAttachmentKind, MessageKind, PendingMessageKind, type Message as AhpMessage,
  type SessionSummary, type ChatState, type ChatSummary, type MessageAttachment } from "@microsoft/agent-host-protocol";
import { AsyncEventQueue } from "./async-event-queue.js";
import { CopilotAhpConnection } from "./copilot-ahp-connection.js";
import { CopilotApprovals } from "./copilot-approvals.js";
import { CopilotEventProjection, copilotHistory } from "./copilot-events.js";
import { discoverVSCodeAgentEndpoints, type VSCodeAgentEndpoint } from "./copilot-vscode-discovery.js";
import type { NativeProtocolSession, NativeSessionProtocol } from "./stdio-native-runtime-adapter.js";
import { RuntimeSessionError, type CreateRuntimeSessionOptions, type RuntimeHealth, type RuntimeModelInfo,
  type RuntimeQuestionAnswer, type RuntimeRunOptions } from "./types.js";

interface CatalogEntry { host: CopilotAhpConnection; session: SessionSummary; chat: string; id: string }
interface ActiveRun { host?: CopilotAhpConnection; chat?: string; turn?: string; cancelled: boolean; sending?: Promise<void>; cancellation?: Promise<void> }
export interface CopilotClientOptions {
  discover?: () => Promise<VSCodeAgentEndpoint[]>;
  connect?: (endpoint: VSCodeAgentEndpoint) => Promise<CopilotAhpConnection>;
}

/** Existing VS Code hosts own credentials, native sessions, tools and permissions. */
export class CopilotClient implements NativeSessionProtocol {
  private readonly hosts = new Map<string, CopilotAhpConnection>();
  private readonly catalog = new Map<string, CatalogEntry>();
  private readonly drafts = new Map<string, CatalogEntry>();
  private readonly running = new Map<string, ActiveRun>();
  private readonly steering = new Map<string, { messageId: string; result: Promise<boolean> }>();
  private readonly approvals = new CopilotApprovals();
  private refreshing: Promise<void> | undefined;

  constructor(private readonly options: CopilotClientOptions = {}) {}

  private async refreshHosts(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const task = (async () => {
      const endpoints = await (this.options.discover ?? discoverVSCodeAgentEndpoints)();
      for (const [id, host] of this.hosts) if (!host.connected || !endpoints.some(endpoint => endpoint.instanceId === id)) {
        this.hosts.delete(id); await host.dispose();
      }
      for (const endpoint of endpoints) if (!this.hosts.has(endpoint.instanceId)) {
        try { this.hosts.set(endpoint.instanceId, await (this.options.connect ?? CopilotAhpConnection.open)(endpoint)); }
        catch { /* A stale endpoint must not hide another live VS Code window. */ }
      }
    })();
    this.refreshing = task;
    try { await task; } finally { this.refreshing = undefined; }
  }

  async available(): Promise<void> {
    await this.refreshHosts();
    if (![...this.hosts.values()].some(host => host.connected && host.copilotProvider)) throw new RuntimeSessionError(
      "未发现可连接的 VS Code Copilot Agent Host，请打开 VS Code 中的 Copilot Agent 会话（需要支持 AHP 1.x 的版本）", "RUNTIME_UNAVAILABLE");
  }

  async health(): Promise<RuntimeHealth> {
    try {
      await this.available();
      return { agentType: "copilot", label: "VS Code Copilot", available: true, connectionMode: "desktop",
        version: [...this.hosts.values()].find(host => host.copilotProvider)?.protocolVersion };
    } catch (error) { return { agentType: "copilot", label: "VS Code Copilot", available: false,
      error: error instanceof Error ? error.message : "VS Code Agent Host 不可用" }; }
  }

  async list(): Promise<NativeProtocolSession[]> {
    await this.refreshHosts();
    this.catalog.clear();
    const result: NativeProtocolSession[] = [];
    for (const host of this.hosts.values()) {
      const provider = host.copilotProvider?.provider;
      if (!provider) continue;
      try {
        for (const session of await host.listSessions()) {
          if (session.provider !== provider || (session.status & 64)) continue;
          const defaultChat = session.defaultChat ?? session.chats?.[0]?.resource;
          if (!defaultChat) continue;
          const chats = session.chats?.length ? session.chats : [{ resource: defaultChat } as ChatSummary];
          for (const chat of chats) {
            if (chat.interactivity === "hidden" || ((chat.status ?? 0) & 64)) continue;
            const id = chat.resource === defaultChat ? session.resource : chat.resource;
            const entry = { host, session, chat: chat.resource, id };
            this.catalog.set(id, entry);
            result.push(this.project(entry, chat));
          }
        }
      } catch { /* A window may close during discovery. */ }
    }
    for (const [id, draft] of this.drafts) {
      if (!draft.host.connected) { this.drafts.delete(id); continue; }
      if (this.catalog.has(id)) { this.drafts.delete(id); continue; }
      this.catalog.set(id, draft);
      result.push(this.project(draft));
    }
    return result;
  }

  private project(entry: CatalogEntry, chat?: Partial<ChatSummary>): NativeProtocolSession {
    let cwd = "";
    try { if (entry.session.workingDirectories?.[0]) cwd = fileURLToPath(entry.session.workingDirectories[0]); } catch { /* Non-file workspace. */ }
    return { id: entry.id, title: chat?.title || entry.session.title || "VS Code Copilot", cwd,
      created: entry.session.createdAt, updated: chat?.modifiedAt ?? entry.session.modifiedAt,
      running: !!((chat?.status ?? entry.session.status) & 8),
      nativePermissions: { currentValue: "跟随 VS Code", options: [] },
      ...(chat?.interactivity === "read-only" ? { readOnly: true } : {}),
      ...(entry.id !== entry.session.resource ? { parentSessionId: entry.session.resource } : {}) };
  }

  private async locate(id: string): Promise<CatalogEntry> {
    if (!/^ahp-(session|chat):/.test(id)) throw new RuntimeSessionError("Invalid VS Code Copilot session ID", "INVALID_SESSION_ID");
    const cached = this.catalog.get(id);
    if (cached?.host.connected) return cached;
    await this.list();
    const entry = this.catalog.get(id);
    if (!entry) throw new RuntimeSessionError("VS Code Copilot 会话不存在，或原窗口已关闭", "SESSION_NOT_FOUND");
    return entry;
  }

  async sessionSummary(id: string): Promise<NativeProtocolSession> {
    const entry = await this.locate(id);
    return this.project(entry, await entry.host.chat(entry.chat));
  }

  async read(id: string) {
    const entry = await this.locate(id);
    const host = entry.host;
    await host.session(entry.session.resource);
    let chat = await host.chat(entry.chat);
    const cursors = new Set<string>();
    while (chat.turnsNextCursor) {
      const cursor = chat.turnsNextCursor;
      if (cursors.has(cursor)) throw new RuntimeSessionError("VS Code 历史分页游标未推进", "NATIVE_PROTOCOL_ERROR");
      cursors.add(cursor);
      await host.client.request("fetchTurns", { channel: chat.resource, cursor });
      chat = host.chatState(entry.chat);
    }
    return { session: this.project(entry, chat), messages: copilotHistory(chat), events: this.approvals.events(host, chat) };
  }

  async create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession> {
    await this.available();
    const host = [...this.hosts.values()].find(host => host.copilotProvider)!;
    const resource = `ahp-session:/${randomUUID()}`;
    await host.client.request("createSession", { channel: resource, provider: host.copilotProvider!.provider,
      workingDirectories: [pathToFileURL(options.cwd).href] });
    await host.session(resource);
    if (options.title) await host.dispatch(resource, { type: ActionType.SessionTitleChanged, title: options.title });
    const state = host.sessionState(resource);
    if (!state.defaultChat) throw new RuntimeSessionError("VS Code 尚未返回新会话，请刷新确认", "NATIVE_PROTOCOL_ERROR");
    const now = new Date().toISOString();
    const entry: CatalogEntry = { host, id: resource, chat: state.defaultChat,
      session: { ...state, resource, createdAt: now, modifiedAt: now } };
    this.catalog.set(resource, entry);
    this.drafts.set(resource, entry);
    return this.project(entry);
  }

  async *run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent> {
    if (this.running.has(id)) throw new RuntimeSessionError("Copilot session is already running", "SESSION_ALREADY_RUNNING");
    const active: ActiveRun = { cancelled: false };
    this.running.set(id, active);
    const queue = new AsyncEventQueue<AgentEvent>();
    const projection = new CopilotEventProjection();
    let stopActions = () => {};
    let stopClose = () => {};
    let terminal = false;
    const finish = (event: AgentEvent) => { if (!terminal) { terminal = true; queue.push(event); queue.close(); } };
    try {
      const entry = await this.locate(id);
      const { host } = entry;
      await host.session(entry.session.resource);
      const chat = await host.chat(entry.chat);
      if (chat.interactivity === "read-only" || chat.interactivity === "hidden") throw new RuntimeSessionError("VS Code 将此会话设为只读", "OPERATION_NOT_SUPPORTED");
      if (chat.activeTurn && chat.steeringMessage) throw new RuntimeSessionError("上一条插入消息仍在等待 Copilot 读取，请先处理会话中的权限确认", "SESSION_ALREADY_RUNNING");
      if (active.cancelled) { yield { type: "turn_aborted" }; return; }
      active.host = host; active.chat = chat.resource;
      active.turn = chat.activeTurn?.id ?? randomUUID();
      const steeringId = chat.activeTurn ? randomUUID() : undefined;
      let acknowledged = false;
      let consumed = !steeringId;
      // Joining a live VS Code turn emits only new parts/deltas.
      if (chat.activeTurn) projection.consume(chat.activeTurn);
      let visibleQuestions = new Set<string>();
      const update = () => {
        const state = host.chatState(chat.resource);
        const turn = state.activeTurn?.id === active.turn ? state.activeTurn : state.turns.find(turn => turn.id === active.turn);
        if (!turn || terminal) return;
        for (const event of projection.consume(turn)) queue.push(event);
        const questions = this.approvals.events(host, state);
        const next = new Set(questions.map(question => question.questionId));
        for (const questionId of visibleQuestions) if (!next.has(questionId)) queue.push({ type: "approval_resolved", questionId });
        for (const question of questions) if (!visibleQuestions.has(question.questionId)) queue.push(question);
        visibleQuestions = next;
        if ("state" in turn && acknowledged) finish(consumed || turn.state === "cancelled" ? projection.terminal(turn) : {
          type: "error", code: "NATIVE_PROTOCOL_ERROR", message: "VS Code 原轮次已结束，追加消息尚未确认被消费，请在原会话确认；未自动重发",
        });
      };
      stopActions = host.onAction(envelope => {
        if (envelope.channel !== chat.resource) return;
        if (envelope.action.type === ActionType.ChatPendingMessageRemoved && envelope.action.id === steeringId) consumed = true;
        update();
      });
      stopClose = host.onClose(() => finish({ type: "error", code: "RUNTIME_UNAVAILABLE", message: "VS Code 连接已断开，请在原会话确认执行状态；未自动重发" }));
      const message = this.message(input, images, options, chat);
      try {
        active.sending = host.dispatch(chat.resource, steeringId
          ? { type: ActionType.ChatPendingMessageSet, kind: PendingMessageKind.Steering, id: steeringId, message }
          : { type: ActionType.ChatTurnStarted, turnId: active.turn, startedAt: new Date().toISOString(), message });
        await active.sending;
        acknowledged = true;
      } catch (error) {
        finish({ type: "error", code: error instanceof RuntimeSessionError ? error.code : "NATIVE_PROTOCOL_ERROR",
          message: error instanceof Error ? error.message : "VS Code 操作未确认；未自动重发" });
      }
      update();
      if (active.cancelled && !terminal) await this.abort(id);
      yield* queue;
    } finally { stopActions(); stopClose(); queue.close(); this.running.delete(id); }
  }

  private message(input: string, images: string[] | undefined, options: RuntimeRunOptions | undefined, chat: ChatState): AhpMessage {
    const model = options?.model ? { id: options.model.id } : chat.draft?.model ?? chat.turns.at(-1)?.message.model;
    const agent = chat.draft?.agent ?? chat.turns.at(-1)?.message.agent;
    if (options?.reasoningEffort) throw new RuntimeSessionError("当前 VS Code Copilot 接入沿用原生推理设置，请在 VS Code 中调整", "OPERATION_NOT_SUPPORTED");
    const attachments: MessageAttachment[] | undefined = images?.map((image, index) => {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(image);
      if (!match) throw new RuntimeSessionError("Copilot images must be base64 image data URLs", "OPERATION_NOT_SUPPORTED");
      return { type: MessageAttachmentKind.EmbeddedResource, label: `Image ${index + 1}`, displayKind: "image", contentType: match[1]!, data: match[2]! };
    });
    return { text: input, origin: { kind: MessageKind.User }, ...(model ? { model } : {}), ...(agent ? { agent } : {}), ...(attachments?.length ? { attachments } : {}) };
  }

  steer(id: string, input: string, messageId = randomUUID()): Promise<boolean> {
    const pending = this.steering.get(id);
    if (pending) {
      if (pending.messageId === messageId) return pending.result;
      return Promise.reject(new RuntimeSessionError("上一条插入消息仍在等待 Copilot 读取，当前消息已保留在队列中", "SESSION_ALREADY_RUNNING"));
    }
    const result = this.consumeSteering(id, input, messageId).finally(() => {
      if (this.steering.get(id)?.result === result) this.steering.delete(id);
    });
    this.steering.set(id, { messageId, result });
    return result;
  }

  private async consumeSteering(id: string, input: string, messageId: string): Promise<boolean> {
    const entry = await this.locate(id);
    const { host } = entry;
    const chat = await host.chat(entry.chat);
    if (!chat.activeTurn || chat.interactivity === "read-only" || chat.interactivity === "hidden") return false;
    if (this.approvals.events(host, chat).length) throw new RuntimeSessionError("Copilot 正在等待权限确认，请先处理上方确认卡；消息已保留在队列中", "OPERATION_NOT_SUPPORTED");
    if (chat.steeringMessage && chat.steeringMessage.id !== messageId) throw new RuntimeSessionError("上一条插入消息仍在等待 Copilot 读取，当前消息已保留在队列中", "SESSION_ALREADY_RUNNING");
    const turnId = chat.activeTurn.id;
    let complete!: (consumed: boolean) => void;
    let fail!: (error: Error) => void;
    const consumed = new Promise<boolean>((resolve, reject) => { complete = resolve; fail = reject; });
    // Keep a rejection observed while the dispatch acknowledgement is still pending.
    void consumed.catch(() => {});
    const stopActions = host.onAction(envelope => {
      if (envelope.channel !== chat.resource) return;
      const { action } = envelope;
      if (action.type === ActionType.ChatPendingMessageRemoved && action.kind === PendingMessageKind.Steering && action.id === messageId) {
        complete(!envelope.origin);
      } else if (action.type === ActionType.ChatPendingMessageSet && action.kind === PendingMessageKind.Steering && action.id !== messageId) {
        complete(false);
      } else if (host.chatState(chat.resource).activeTurn?.id !== turnId) complete(false);
    });
    const stopClose = host.onClose(() => fail(new RuntimeSessionError("VS Code 连接已断开，插入消息尚未确认被消费；请刷新原会话确认，未自动重发", "RUNTIME_UNAVAILABLE")));
    try {
      if (!chat.steeringMessage) await host.dispatch(chat.resource, { type: ActionType.ChatPendingMessageSet, kind: PendingMessageKind.Steering,
        id: messageId, message: { text: input, origin: { kind: MessageKind.User } } });
      return await consumed;
    } finally { stopActions(); stopClose(); }
  }

  async abort(id: string): Promise<void> {
    const running = this.running.get(id);
    if (running) running.cancelled = true;
    if (running && !running.host) return;
    if (running?.cancellation) return running.cancellation;
    const cancellation = (async () => {
      // A cancel requested during admission must follow the send acknowledgement.
      try { await running?.sending; } catch { /* The exact native turn is still safe to inspect and cancel. */ }
      await this.cancelNativeTurn(id, running?.turn);
    })();
    if (running) running.cancellation = cancellation;
    return cancellation;
  }

  private async cancelNativeTurn(id: string, expectedTurn?: string): Promise<void> {
    const entry = await this.locate(id);
    const chat = await entry.host.chat(entry.chat);
    const turnId = expectedTurn ?? chat.activeTurn?.id;
    if (turnId && chat.activeTurn?.id === turnId) await entry.host.dispatch(chat.resource,
      { type: ActionType.ChatTurnCancelled, turnId, duration: 0 });
  }

  answerQuestion(id: string, answer: RuntimeQuestionAnswer) { return this.approvals.answer(id, answer); }
  async getSessionWatchPath(_id: string): Promise<null> { return null; }
  async listModels(): Promise<RuntimeModelInfo[]> {
    await this.available();
    const models = new Map<string, RuntimeModelInfo>();
    for (const host of this.hosts.values()) for (const model of host.copilotProvider?.models ?? []) {
      if (model.policyState === "disabled") continue;
      models.set(model.id, { id: model.id, displayName: model.name });
    }
    return [...models.values()];
  }
  async dispose(): Promise<void> { for (const host of this.hosts.values()) await host.dispose(); this.hosts.clear(); this.catalog.clear(); this.drafts.clear(); }
}
