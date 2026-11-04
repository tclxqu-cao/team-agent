import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@microsoft/agent-host-protocol/client";
import { ActionType, MessageKind, SessionStatus, SessionLifecycle, chatReducer, sessionReducer, type ChatState, type SessionState,
  type StateAction, type ChatAction, type SessionAction, type SessionSummary, type ActionEnvelope } from "@microsoft/agent-host-protocol";
import type { AgentEvent } from "@agent/core";
import { CopilotAhpConnection } from "./copilot-ahp-connection.js";
import { CopilotClient } from "./copilot-client.js";
import { CopilotRuntimeAdapter } from "./copilot-runtime-adapter.js";
import type { VSCodeAgentEndpoint } from "./copilot-vscode-discovery.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });
const collect = async (events: AsyncIterable<AgentEvent>) => { const result: AgentEvent[] = []; for await (const event of events) result.push(event); return result; };

async function fixture(ackTimeout = 300) {
  const [clientTransport, server] = InMemoryTransport.pair();
  const connection = new CopilotAhpConnection("editor-host", clientTransport, ackTimeout);
  let seq = 1; let clientId = "";
  let sessionURI = "ahp-session:/existing-vscode"; let chatURI = "ahp-chat:/existing-chat";
  let provisional = false;
  const session: SessionState = { provider: "copilotcli", title: "Existing VS Code", status: SessionStatus.Idle, lifecycle: SessionLifecycle.Ready,
    activeClients: [{ clientId: "original-editor", displayName: "VS Code", tools: [] }], chats: [], defaultChat: chatURI, workingDirectories: ["file:///workspace/project"],
    config: { schema: { type: "object", properties: {} }, values: { autoApprove: "default", mode: "interactive" } } } as SessionState;
  let chat: ChatState = { resource: chatURI, title: "Existing VS Code", status: SessionStatus.Idle, modifiedAt: "2026-11-03T00:00:00Z", turns: [],
    draft: { text: "editor draft", origin: { kind: MessageKind.User }, model: { id: "native-model" }, agent: { uri: "file:///workspace/native.agent.md" } } };
  const root = { agents: [{ provider: "copilotcli", displayName: "Copilot", description: "", models: [{ id: "native-model", provider: "copilotcli", name: "Native Model" }] }] };
  const messages: Array<{ method: string; params: any }> = [];
  let onDispatch = (_channel: string, _action: StateAction) => {};
  let dropDispatch = false; let rejectDispatch = false;
  const notify = async (action: StateAction, channel = chatURI, origin?: ActionEnvelope["origin"], rejectionReason?: string, serverSeq = ++seq) => {
    if (!rejectionReason) {
      if (channel === chatURI) chat = chatReducer(chat, action as ChatAction);
      else if (channel === sessionURI) Object.assign(session, sessionReducer(session, action as SessionAction));
    }
    await server.send({ jsonrpc: "2.0", method: "action", params: { channel, action, serverSeq, origin, ...(rejectionReason ? { rejectionReason } : {}) } });
  };
  const summary = (): SessionSummary => ({ ...session, resource: sessionURI, createdAt: "2026-11-02T00:00:00Z", modifiedAt: chat.modifiedAt,
    status: chat.status, chats: [{ resource: chatURI, title: chat.title, status: chat.status, interactivity: chat.interactivity }], defaultChat: chatURI });
  const loop = (async () => {
    while (true) {
      const frame = await server.recv(); if (!frame) break;
      if (frame.kind !== "text") throw new Error("Unexpected frame");
      const message = JSON.parse(frame.text); messages.push(message);
      const { method, params } = message;
      if (method === "dispatchAction") {
        if (dropDispatch) continue;
        await notify(params.action, params.channel, { clientId, clientSeq: params.clientSeq }, rejectDispatch ? "stale native turn" : undefined);
        if (!rejectDispatch) { if (params.action.type === ActionType.ChatTurnStarted) provisional = false; onDispatch(params.channel, params.action); }
        continue;
      }
      if (!('id' in message)) continue;
      let result: unknown;
      if (method === "initialize") { clientId = params.clientId; result = { protocolVersion: "1.0.0", serverSeq: seq, snapshots: [] }; }
      else if (method === "subscribe") result = { snapshot: { resource: params.channel, state: params.channel === "ahp-root://" ? root : params.channel === sessionURI ? session : chat, fromSeq: seq } };
      else if (method === "listSessions") result = { items: provisional ? [] : [summary(), { ...summary(), resource: "ahp-session:/codex", provider: "codex" }] };
      else if (method === "createSession") { sessionURI = params.channel; chatURI = "ahp-chat:/provisional"; provisional = true; session.defaultChat = chatURI; session.lifecycle = SessionLifecycle.Creating; chat = { ...chat, resource: chatURI }; result = null; }
      else if (method === "fetchTurns") {
        await notify({ type: ActionType.ChatTurnsLoaded, turns: [{ id: "older", startedAt: "2026-11-01T00:00:00Z", message: { text: "old", origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined, state: "complete" } as any] });
        result = {};
      } else result = null;
      await server.send({ jsonrpc: "2.0", id: message.id, result });
    }
  })();
  await connection.initialize();
  const client = new CopilotClient({ discover: async () => [{ instanceId: "editor-host" } as VSCodeAgentEndpoint], connect: async () => connection });
  const adapter = new CopilotRuntimeAdapter(client);
  cleanups.push(async () => { await client.dispose(); await connection.dispose(); await server.close(); await loop; });
  return { adapter, client, connection, get sessionURI() { return sessionURI; }, get chatURI() { return chatURI; }, messages, session, notify, chat: () => chat,
    setChat: (value: Partial<ChatState>) => { chat = { ...chat, ...value }; },
    behavior: (fn: typeof onDispatch) => { onDispatch = fn; }, drop: () => { dropDispatch = true; }, reject: () => { rejectDispatch = true; },
    disconnect: async () => { await server.close(); } };
}

describe("VS Code Copilot native adapter", () => {
  it("discovers and reads the same native session without creating/resuming another process", async () => {
    const f = await fixture();
    f.setChat({ turnsNextCursor: "older-page" });
    expect(await f.adapter.health()).toMatchObject({ available: true, connectionMode: "desktop" });
    const sessions = await f.adapter.discoverSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ nativeSessionId: f.sessionURI, cwd: "/workspace/project", sourceLabel: "VS Code Copilot", canResume: true });
    const detail = await f.adapter.getSession(f.sessionURI);
    expect(detail.messages).toEqual([{ role: "user", content: "old", historyId: "older:user" }]);
    expect(await f.adapter.listModels()).toEqual([{ id: "native-model", displayName: "Native Model" }]);
    expect(f.messages.every(message => ["initialize", "subscribe", "listSessions", "fetchTurns"].includes(message.method))).toBe(true);
    expect(f.session.activeClients).toEqual([{ clientId: "original-editor", displayName: "VS Code", tools: [] }]);
    expect(f.session.config?.values).toEqual({ autoApprove: "default", mode: "interactive" });
  });

  it("sends to the existing native chat, streams parts once and retains native model selection", async () => {
    const f = await fixture();
    f.behavior((_channel, action) => {
      if (action.type !== ActionType.ChatTurnStarted) return;
      void (async () => {
        await f.notify({ type: ActionType.ChatResponsePart, turnId: action.turnId, part: { kind: "markdown", id: "part", content: "Hello" } } as any);
        await f.notify({ type: ActionType.ChatDelta, turnId: action.turnId, partId: "part", content: " world" });
        await f.notify({ type: ActionType.ChatUsage, turnId: action.turnId, usage: { inputTokens: 12, outputTokens: 5 } });
        await f.notify({ type: ActionType.ChatTurnComplete, turnId: action.turnId, duration: 500 });
      })();
    });
    const events = await collect(f.adapter.run(f.sessionURI, "continue", undefined, undefined, undefined, { permissionMode: "full-access" }));
    expect(events.filter(event => event.type === "text_chunk").map(event => event.text).join("")).toBe("Hello world");
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "Hello world", usage: { totalTokens: 17 }, durationMs: 500 });
    const actions = f.messages.filter(message => message.method === "dispatchAction");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.params).toMatchObject({ channel: f.chatURI, action: { type: "chat/turnStarted", message: { text: "continue", model: { id: "native-model" }, agent: { uri: "file:///workspace/native.agent.md" } } } });
    expect(f.session.config?.values.autoApprove).toBe("default");
    expect(f.messages.some(message => ["createSession", "authenticate"].includes(message.method))).toBe(false);
  });

  it("joins an already running VS Code turn through steering and cancels that exact turn", async () => {
    const f = await fixture();
    f.setChat({ status: SessionStatus.InProgress, activeTurn: { id: "original-turn", startedAt: "2026-11-03T00:00:00Z", message: { text: "working", origin: { kind: MessageKind.User } }, responseParts: [{ kind: "markdown", id: "old", content: "Already shown" }], usage: undefined } as any });
    const summary = await f.adapter.getSessionSummary(f.sessionURI);
    expect(summary).toMatchObject({ status: "running", occupancy: "available", canResume: true });
    f.behavior((_channel, action) => { if (action.type === ActionType.ChatPendingMessageSet) { void f.notify({ type: ActionType.ChatPendingMessageRemoved, kind: action.kind, id: action.id }); void f.adapter.abort(f.sessionURI); } });
    const events = await collect(f.adapter.run(f.sessionURI, "please stop after this"));
    expect(events).toEqual([expect.objectContaining({ type: "turn_aborted" })]);
    const actions = f.messages.filter(message => message.method === "dispatchAction").map(message => message.params.action);
    expect(actions).toMatchObject([{ type: "chat/pendingMessageSet", kind: "steering", message: { text: "please stop after this" } }, { type: "chat/turnCancelled", turnId: "original-turn" }]);
  });

  it("projects native approval requests for an existing turn and rejects stale answers", async () => {
    const f = await fixture();
    f.setChat({ activeTurn: { id: "approval-turn", startedAt: "2026-11-03T00:00:00Z", message: { text: "run", origin: { kind: MessageKind.User } }, responseParts: [{ kind: "toolCall", toolCall: {
      status: "pending-confirmation", toolCallId: "native-tool", toolName: "bash", displayName: "Bash", intention: "test", invocationMessage: "Run command", toolInput: '{"command":"echo ok"}',
    } }], usage: undefined } as any });
    const detail = await f.adapter.getSession(f.sessionURI);
    const question = detail.events.find(event => event.type === "ask_user");
    expect(question?.type).toBe("ask_user"); if (question?.type !== "ask_user") return;
    expect(await f.adapter.answerQuestion(question.questionId, { answer: "允许一次", selectedIndices: [0] })).toBe(true);
    expect(await f.adapter.answerQuestion(question.questionId, { answer: "允许一次" })).toBe(false);
    expect(f.messages.at(-1)?.params).toMatchObject({ channel: f.chatURI, action: { type: "chat/toolCallConfirmed", turnId: "approval-turn", toolCallId: "native-tool", approved: true, confirmed: "user-action" } });
  });

  it("does not replay an uncertain send or claim completion after disconnect", async () => {
    const f = await fixture(30); f.drop();
    const events = await collect(f.adapter.run(f.sessionURI, "send exactly once"));
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("未自动重发") });
    expect(f.messages.filter(message => message.method === "dispatchAction")).toHaveLength(1);
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  it("reports native rejections and closes a streaming run on host disconnect", async () => {
    const f = await fixture(); f.reject();
    expect((await collect(f.adapter.run(f.sessionURI, "rejected"))).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("stale native turn") });
    const g = await fixture(); g.behavior(() => { void g.disconnect(); });
    expect((await collect(g.adapter.run(g.sessionURI, "disconnect"))).at(-1)).toMatchObject({ type: "error", code: "RUNTIME_UNAVAILABLE" });
  });

  it("keeps a provisional VS Code session usable before the host publishes it in listSessions", async () => {
    const f = await fixture();
    const created = await f.adapter.create({ title: "New native chat", cwd: "/workspace/project" });
    expect(created.nativeSessionId).toBe(f.sessionURI);
    expect(await f.adapter.discoverSessions()).toHaveLength(1);
    f.behavior((_channel, action) => { if (action.type === ActionType.ChatTurnStarted) void f.notify({ type: ActionType.ChatTurnComplete, turnId: action.turnId, duration: 1 }); });
    expect((await collect(f.adapter.run(created.nativeSessionId, "first"))).at(-1)?.type).toBe("done");
    expect(f.messages.filter(message => message.method === "createSession")).toHaveLength(1);
    expect(f.messages.find(message => message.method === "createSession")?.params).not.toHaveProperty("activeClient");
  });

  it("does not claim delivery when a VS Code turn ends before consuming steering", async () => {
    const f = await fixture();
    f.setChat({ status: SessionStatus.InProgress, activeTurn: { id: "old-turn", startedAt: "2026-11-03T00:00:00Z", message: { text: "working", origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined } as any });
    f.behavior((_channel, action) => { if (action.type === ActionType.ChatPendingMessageSet) void f.notify({ type: ActionType.ChatTurnComplete, turnId: "old-turn", duration: 1 }); });
    const events = await collect(f.adapter.run(f.sessionURI, "new instruction"));
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("尚未确认被消费") });
    expect(events.some(event => event.type === "done")).toBe(false);
  });

  it("answers multi-question native input incrementally without re-asking submitted questions", async () => {
    const f = await fixture();
    f.setChat({ activeTurn: { id: "questions", startedAt: "2026-11-03T00:00:00Z", message: { text: "ask", origin: { kind: MessageKind.User } }, responseParts: [{ kind: "inputRequest", request: { id: "request", questions: [
      { id: "pick", kind: "single-select", message: "Choose", options: [{ id: "native-a", label: "A" }, { id: "native-b", label: "B" }] },
      { id: "text", kind: "text", message: "Explain" },
    ] } }], usage: undefined } as any });
    const detail = await f.adapter.getSession(f.sessionURI);
    const first = detail.events.find(event => event.type === "ask_user" && event.question === "Choose");
    if (first?.type !== "ask_user") throw new Error("Missing native question");
    const answers = await Promise.all([f.adapter.answerQuestion(first.questionId, { answer: "B", selectedIndices: [1] }), f.adapter.answerQuestion(first.questionId, { answer: "A", selectedIndices: [0] })]);
    expect(answers).toEqual([true, false]);
    const remaining = (await f.adapter.getSession(f.sessionURI)).events;
    expect(remaining).toHaveLength(1);
    const second = remaining[0]; if (second?.type !== "ask_user") throw new Error("Missing second native question");
    expect(second.question).toBe("Explain");
    expect(await f.adapter.answerQuestion(second.questionId, { answer: "because" })).toBe(true);
    const actions = f.messages.filter(message => message.method === "dispatchAction").map(message => message.params.action);
    expect(actions).toMatchObject([{ type: "chat/inputAnswerChanged", questionId: "pick", answer: { value: { value: "native-b" } } }, { type: "chat/inputAnswerChanged", questionId: "text" }, { type: "chat/inputCompleted", response: "accept" }]);
  });

  it("blocks simultaneous runs and read-only chats", async () => {
    const f = await fixture();
    const first = collect(f.adapter.run(f.sessionURI, "one"));
    await vi.waitFor(() => expect(f.chat().activeTurn).toBeDefined());
    await expect(collect(f.adapter.run(f.sessionURI, "two"))).rejects.toMatchObject({ code: "SESSION_ALREADY_RUNNING" });
    await f.adapter.abort(f.sessionURI); await first;
    const g = await fixture(); g.setChat({ interactivity: "read-only" } as any);
    await expect(collect(g.adapter.run(g.sessionURI, "forbidden"))).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    expect(g.messages.some(message => message.method === "dispatchAction")).toBe(false);
  });

  it("keeps steering pending after the VS Code echo and confirms only server consumption", async () => {
    const f = await fixture();
    f.setChat({ activeTurn: { id: "working", startedAt: "2026-11-03T00:00:00Z", message: { text: "original", origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined } });
    let settled = false;
    const pending = f.adapter.steer(f.sessionURI, "follow up", "queue-1").then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(f.chat().steeringMessage?.id).toBe("queue-1"));
    expect(settled).toBe(false);
    expect((await f.adapter.getSession(f.sessionURI)).messages.at(-1)).toMatchObject({ content: "follow up", historyId: "copilot-steering:queue-1" });
    await f.notify({ type: ActionType.ChatPendingMessageRemoved, kind: "steering", id: "queue-1" } as any);
    await expect(pending).resolves.toBe(true);
    expect(f.messages.filter(message => message.method === "dispatchAction")).toHaveLength(1);
  });

  it("does not overwrite native steering and shares a duplicate durable request", async () => {
    const f = await fixture();
    f.setChat({ activeTurn: { id: "working", startedAt: "2026-11-03T00:00:00Z", message: { text: "original", origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined } });
    const pending = f.adapter.steer(f.sessionURI, "first", "queue-1");
    const duplicate = f.adapter.steer(f.sessionURI, "first", "queue-1");
    await vi.waitFor(() => expect(f.chat().steeringMessage?.id).toBe("queue-1"));
    await expect(f.adapter.steer(f.sessionURI, "second", "queue-2")).rejects.toThrow("上一条插入消息");
    await f.notify({ type: ActionType.ChatPendingMessageRemoved, kind: "steering", id: "queue-1" } as any);
    await expect(Promise.all([pending, duplicate])).resolves.toEqual([true, true]);
    expect(f.messages.filter(message => message.method === "dispatchAction")).toHaveLength(1);

    await f.notify({ type: ActionType.ChatPendingMessageSet, kind: "steering", id: "native-existing", message: { text: "existing", origin: { kind: MessageKind.User } } } as any);
    await expect(f.adapter.steer(f.sessionURI, "third", "queue-3")).rejects.toThrow("上一条插入消息");
    expect(f.chat().steeringMessage?.id).toBe("native-existing");
  });

  it("keeps queued input untouched while a native command needs approval", async () => {
    const f = await fixture();
    f.setChat({ activeTurn: { id: "earth", startedAt: "2026-11-03T14:50:48Z", message: { text: "earth", origin: { kind: MessageKind.User } }, usage: undefined,
      responseParts: [{ kind: "toolCall", toolCall: { status: "pending-confirmation", toolCallId: "cdn", toolName: "bash", displayName: "Shell", intention: "Check CDN", toolInput: "{}", options: [{ id: "once", label: "允许一次", kind: "approve" }] } }] } as any });
    await expect(f.adapter.steer(f.sessionURI, "why stuck", "queue-1")).rejects.toThrow("请先处理上方确认卡");
    expect(f.messages.some(message => message.method === "dispatchAction")).toBe(false);
    expect((await f.adapter.getSession(f.sessionURI)).events).toContainEqual(expect.objectContaining({ type: "ask_user", question: expect.stringContaining("Shell") }));
  });

  it("does not count a client cancellation or a finished turn as consumed steering", async () => {
    const f = await fixture();
    f.setChat({ activeTurn: { id: "working", startedAt: "2026-11-03T00:00:00Z", message: { text: "original", origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined } });
    const pending = f.adapter.steer(f.sessionURI, "follow up", "queue-1");
    await vi.waitFor(() => expect(f.chat().steeringMessage?.id).toBe("queue-1"));
    await f.notify({ type: ActionType.ChatPendingMessageRemoved, kind: "steering", id: "queue-1" } as any, f.chatURI, { clientId: "editor", clientSeq: 1 });
    await expect(pending).resolves.toBe(false);
    const next = f.adapter.steer(f.sessionURI, "again", "queue-2");
    await vi.waitFor(() => expect(f.chat().steeringMessage?.id).toBe("queue-2"));
    await f.notify({ type: ActionType.ChatTurnComplete, turnId: "working", duration: 1 });
    await expect(next).resolves.toBe(false);
  });
});
