import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@agent/core";
import { CodexRuntimeAdapter } from "./codex-runtime-adapter.js";
import { assertCodexTodoMcpReady, codexTodoMcpConfiguration, resumeCodexThreadWithTodo } from "./codex-todo-mcp.js";
import { TODO_NATIVE_INJECTION_SUPPORT, type NativeTodoMcpConfiguration } from "./runtime-tool-injection.js";
import type { RpcNotification } from "./codex-app-server-client.js";
import type { CodexDesktopTools } from "./codex-desktop-tools.js";
import { RuntimeSessionError } from "./types.js";

vi.mock("./native-processes.js", () => ({ listOpenSessionFiles: async () => new Set() }));

const configuration = (descriptor = "/tmp/service-a.json"): NativeTodoMcpConfiguration => ({
  command: "/runtime/node", args: ["/runtime/todo.mjs"], env: { AGENTROAM_TODO_DESCRIPTOR: descriptor },
});

function fixture(options: { desktopTools?: Pick<CodexDesktopTools, "connect"> } = {}) {
  let notify: (message: RpcNotification) => void = () => undefined;
  let subscribed = false;
  let nativeConfiguration: Record<string, unknown> = {};
  let fresh = false;
  const state = { otherSubscriber: false, connected: true, sentConfigurations: [] as Array<Record<string, unknown>> };
  const thread = { id: "todo-thread", parentThreadId: null, preview: "Todo", name: "Todo", createdAt: 1, updatedAt: 1,
    status: { type: "idle" }, cwd: "/workspace", path: null, source: { custom: "customer-agent" }, turns: [] };
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "thread/start") {
      nativeConfiguration = params.config as Record<string, unknown> ?? {};
      subscribed = true; fresh = true;
      return { thread };
    }
    if (method === "thread/read") return { thread };
    if (method === "thread/name/set") return {};
    if (method === "thread/unsubscribe") { subscribed = false; return { status: "unsubscribed" }; }
    if (method === "thread/resume") {
      if (fresh) throw new Error(`no rollout found for thread id ${thread.id}`);
      if (!subscribed && !state.otherSubscriber && thread.status.type !== "active") nativeConfiguration = params.config as Record<string, unknown> ?? {};
      subscribed = true;
      return { thread };
    }
    if (method === "mcpServerStatus/list") {
      const applied = nativeConfiguration[`mcp_servers.${params.serverName}`];
      return { data: applied ? [{ name: params.serverName, runtimeStatus: state.connected ? "connected" : "failed",
        tools: { todo_get: { name: "todo_get" }, todo_create: { name: "todo_create" } } }] : [] };
    }
    if (method === "turn/start") {
      fresh = false;
      state.sentConfigurations.push(nativeConfiguration);
      queueMicrotask(() => notify({ method: "turn/completed", params: { threadId: thread.id, turn: {
        id: "todo-turn", status: "completed", items: [],
      } } }));
      return { turn: { id: "todo-turn" } };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request, mode: "shared", onNotification: (handler: typeof notify) => { notify = handler; return () => undefined; },
    onExit: () => () => undefined, setServerRequestHandler: () => undefined, dispose: async () => undefined };
  const adapter = new CodexRuntimeAdapter({ client: client as never, sessionRoot: "/tmp", desktopTools: options.desktopTools ?? null,
    platform: options.desktopTools ? "win32" : undefined });
  return { adapter, client, request, thread, state };
}

async function collect(source: AsyncIterable<AgentEvent>) {
  const result: AgentEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

describe("Codex per-thread Todo MCP configuration", () => {
  it("advertises only the verified session injection route", () => {
    expect(TODO_NATIVE_INJECTION_SUPPORT.codex).toBe("session");
  });

  it.each([
    { command: "/opt/Agent Roam/node", args: ["/srv/Agent Roam/todo.mjs", "--service", "linux-computer"],
      env: { AGENTROAM_TODO_DESCRIPTOR: "/run/user/1001/Agent Roam/service.json", EXTRA: "preserve spaces" } },
    { command: "C:\\Program Files\\nodejs\\node.exe", args: ["D:\\Agent Roam\\todo.mjs", "--service", "windows-computer"],
      env: { AGENTROAM_TODO_DESCRIPTOR: "C:\\Users\\Alice Smith\\AppData\\Local\\Agent Roam\\service.json", EXTRA: "preserve spaces" } },
  ])("preserves platform paths and argument boundaries: $command", async config => {
    const injection = codexTodoMcpConfiguration(config);
    expect(injection.config[`mcp_servers.${injection.serverName}`]).toEqual({ ...config, enabled: true, required: true });
    expect(`mcp__${injection.serverName}__todo_report_execution`.length).toBeLessThanOrEqual(64);
    const { adapter, request } = fixture();
    await adapter.create({ title: "Portable Todo", cwd: "/workspace", todoMcp: config });
    expect(request).toHaveBeenCalledWith("thread/start", expect.objectContaining({ config: injection.config }));
  });

  it("uses stable names for reordered env keys and distinct names for different credentials", () => {
    const a = { ...configuration(), env: { Z: "last", A: "first" } };
    const b = { ...a, env: { A: "first", Z: "last" } };
    expect(codexTodoMcpConfiguration(a).serverName).toBe(codexTodoMcpConfiguration(b).serverName);
    expect(codexTodoMcpConfiguration(configuration()).serverName).not.toBe(codexTodoMcpConfiguration(configuration("/tmp/service-b.json")).serverName);
    expect(codexTodoMcpConfiguration(configuration()).serverName).not.toContain("service-a");
  });

  it("keeps a new verified resident for the first real turn instead of resuming an empty rollout", async () => {
    const { adapter, request, state } = fixture();
    const config = configuration();
    const session = await adapter.create({ title: "Todo", cwd: "/workspace", todoMcp: config });
    expect(request.mock.calls.some(([method]) => method === "thread/unsubscribe")).toBe(false);
    const events = await collect(adapter.run(session.nativeSessionId, "Use Todo"));
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(state.sentConfigurations).toEqual([codexTodoMcpConfiguration(config).config]);
    expect(request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
    expect(request.mock.calls.at(-1)?.[0]).toBe("thread/unsubscribe");
    await collect(adapter.run(session.nativeSessionId, "Use Todo again"));
    expect(request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(1);
    expect(state.sentConfigurations).toHaveLength(2);
  });

  it("drops only its own subscription before configured cold resume and validates readiness before sending", async () => {
    const { adapter, request, state, thread } = fixture();
    const config = configuration();
    const events = await collect(adapter.run(thread.id, "Use Todo", undefined, undefined, undefined, { todoMcp: config }));
    expect(events.some(event => event.type === "error")).toBe(false);
    const methods = request.mock.calls.map(([method]) => method);
    expect(methods.indexOf("thread/unsubscribe")).toBeLessThan(methods.indexOf("thread/resume"));
    expect(methods.indexOf("mcpServerStatus/list")).toBeLessThan(methods.indexOf("turn/start"));
    expect(state.sentConfigurations).toEqual([codexTodoMcpConfiguration(config).config]);
    expect(request.mock.calls.some(([method]) => /config\/.*write|mcpServer\/refresh|thread\/archive/.test(method))).toBe(false);
  });

  it("does not send when another client keeps the native override from applying", async () => {
    const { adapter, request, state, thread } = fixture();
    state.otherSubscriber = true;
    const events = await collect(adapter.run(thread.id, "Use Todo", undefined, undefined, undefined, { todoMcp: configuration() }));
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "OPERATION_NOT_SUPPORTED" }));
    expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(state.sentConfigurations).toEqual([]);
  });

  it.each(["thread/unsubscribe", "thread/resume", "mcpServerStatus/list"])("honors a stop during Todo preparation at %s", async phase => {
    const { adapter, request, state, thread } = fixture();
    const original = request.getMockImplementation()!;
    let reached!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    request.mockImplementation(async (method, params) => {
      const response = await original(method, params);
      if (method === phase && !held) { held = true; reached(); await blocked; }
      return response;
    });
    const running = collect(adapter.run(thread.id, "Do not send", undefined, undefined, undefined, { todoMcp: configuration() }));
    await started;
    await adapter.abort(thread.id);
    release();
    expect(await running).toEqual([{ type: "turn_aborted" }]);
    expect(state.sentConfigurations).toEqual([]);
    expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    await collect(adapter.run(thread.id, "Retry", undefined, undefined, undefined, { todoMcp: configuration() }));
    expect(state.sentConfigurations).toHaveLength(1);
  });

  it("honors a stop while rechecking a never-sent Todo resident", async () => {
    const { adapter, request, state } = fixture();
    const session = await adapter.create({ title: "Todo draft", cwd: "/workspace", todoMcp: configuration() });
    const original = request.getMockImplementation()!;
    let reached!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    request.mockImplementation(async (method, params) => {
      const response = await original(method, params);
      if (method === "mcpServerStatus/list" && !held) { held = true; reached(); await blocked; }
      return response;
    });
    const running = collect(adapter.run(session.nativeSessionId, "Do not send"));
    await started;
    await adapter.abort(session.nativeSessionId);
    release();
    expect(await running).toEqual([{ type: "turn_aborted" }]);
    expect(request.mock.calls.some(([method]) => method === "thread/resume" || method === "turn/start")).toBe(false);
    await collect(adapter.run(session.nativeSessionId, "Retry"));
    expect(state.sentConfigurations).toHaveLength(1);
  });

  it("does not accept an old credential's tool catalog after a configured descriptor changes", async () => {
    const { adapter, state, thread } = fixture();
    const first = configuration("/tmp/service-a.json");
    await collect(adapter.run(thread.id, "Use service A", undefined, undefined, undefined, { todoMcp: first }));
    state.otherSubscriber = true;
    const events = await collect(adapter.run(thread.id, "Use service B", undefined, undefined, undefined, { todoMcp: configuration("/tmp/service-b.json") }));
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "OPERATION_NOT_SUPPORTED" }));
    expect(state.sentConfigurations).toEqual([codexTodoMcpConfiguration(first).config]);
  });

  it("leaves an active native thread untouched", async () => {
    const { adapter, request, thread } = fixture();
    thread.status.type = "active";
    await expect(collect(adapter.run(thread.id, "Use Todo", undefined, undefined, undefined, { todoMcp: configuration() }))).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    expect(request.mock.calls.some(([method]) => ["thread/unsubscribe", "thread/resume", "turn/start"].includes(method))).toBe(false);
  });

  it("rejects a failed or unrelated MCP connection", async () => {
    const { client, state } = fixture();
    const injection = codexTodoMcpConfiguration(configuration());
    await client.request("thread/start", { config: injection.config });
    state.connected = false;
    await expect(assertCodexTodoMcpReady(client as never, "todo-thread", injection.serverName)).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    await expect(assertCodexTodoMcpReady(client as never, "todo-thread", "not-configured")).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
  });

  it("retries only the native transient closing response", async () => {
    const { client, request } = fixture();
    const original = request.getMockImplementation()!;
    let closing = true;
    request.mockImplementation(async (method, params) => {
      if (method === "thread/resume" && closing) { closing = false; throw new Error("thread todo-thread is closing; retry thread/resume after the thread is closed"); }
      return original(method, params);
    });
    await resumeCodexThreadWithTodo(client as never, "todo-thread", configuration());
    expect(request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(2);
  });

  it("releases never-sent Todo subscriptions when disposing the adapter", async () => {
    const { adapter, request } = fixture();
    await adapter.create({ title: "Todo draft", cwd: "/workspace", todoMcp: configuration() });
    await adapter.dispose();
    expect(request.mock.calls.filter(([method]) => method === "thread/unsubscribe")).toHaveLength(1);
  });
});

describe("optional Codex Todo startup for ordinary conversations", () => {
  const background = (): NativeTodoMcpConfiguration => ({ ...configuration(), readiness: "background" });

  it("marks only background MCP startup optional without changing its scoped identity", () => {
    const required = codexTodoMcpConfiguration(configuration());
    const optional = codexTodoMcpConfiguration(background());
    expect(optional.serverName).toBe(required.serverName);
    expect(optional.config[`mcp_servers.${optional.serverName}`]).toEqual({ ...configuration(), enabled: true, required: false });
    expect(required.config[`mcp_servers.${required.serverName}`].required).toBe(true);
  });

  it("creates and sends the first two messages while MCP readiness is unavailable", async () => {
    const { adapter, request, state } = fixture();
    state.connected = false;
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => method === "mcpServerStatus/list"
      ? new Promise(() => {}) : original(method, params));
    const created = await adapter.create({ title: "Ordinary chat", cwd: "/workspace", todoMcp: background() });
    const first = await collect(adapter.run(created.nativeSessionId, "first message"));
    expect(first.some(event => event.type === "error")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
    const second = await collect(adapter.run(created.nativeSessionId, "second message"));
    expect(second.some(event => event.type === "error")).toBe(false);
    expect(request.mock.calls.some(([method]) => method === "mcpServerStatus/list")).toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(1);
    expect(state.sentConfigurations).toEqual([codexTodoMcpConfiguration(background()).config, codexTodoMcpConfiguration(background()).config]);
  });

  it("adds optional tools as part of a cold thread's single normal resume", async () => {
    const { adapter, request, thread, state } = fixture();
    state.connected = false;
    const events = await collect(adapter.run(thread.id, "ordinary follow up", undefined, undefined, undefined, { todoMcp: background() }));
    expect(events.some(event => event.type === "error")).toBe(false);
    const methods = request.mock.calls.map(([method]) => method);
    expect(methods.filter(method => method === "thread/resume")).toHaveLength(1);
    expect(methods.indexOf("thread/resume")).toBeLessThan(methods.indexOf("turn/start"));
    expect(methods.indexOf("thread/unsubscribe")).toBeGreaterThan(methods.indexOf("turn/start"));
    expect(methods).not.toContain("mcpServerStatus/list");
    expect(state.sentConfigurations).toEqual([codexTodoMcpConfiguration(background()).config]);
  });

  it.each(["subscribed", "active"])("preserves a %s resident when native resume ignores the optional override", async resident => {
    const { adapter, request, thread, state } = fixture();
    state.otherSubscriber = resident === "subscribed";
    if (resident === "active") thread.status.type = "active";
    const events = await collect(adapter.run(thread.id, "ordinary follow up", undefined, undefined, undefined, { todoMcp: background() }));
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(state.sentConfigurations).toEqual([{}]);
    const methods = request.mock.calls.map(([method]) => method);
    expect(methods.filter(method => method === "thread/resume")).toHaveLength(1);
    expect(methods.indexOf("thread/unsubscribe")).toBeGreaterThan(methods.indexOf("turn/start"));
    expect(methods.some(method => /mcpServer|config\/|thread\/archive/.test(method))).toBe(false);
  });

  it("retains the original-client continuation when ordinary resume is occupied", async () => {
    const text = "ordinary follow up";
    const connection = { read: vi.fn().mockResolvedValueOnce({ thread: { id: "todo-thread" }, turns: [] }).mockResolvedValue({
      thread: { id: "todo-thread" }, turns: [{ id: "desktop-turn", status: "completed", items: [
        { id: "desktop-user", type: "userMessage", content: [{ type: "text", text }] },
        { id: "desktop-answer", type: "agentMessage", text: "continued", phase: "final_answer" },
      ] }],
    }), send: vi.fn(), close: vi.fn() };
    const connect = vi.fn().mockResolvedValue(connection);
    const { adapter, request, thread } = fixture({ desktopTools: { connect } });
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method === "thread/resume") throw new RuntimeSessionError("active writer", "SESSION_OCCUPIED");
      return original(method, params);
    });
    const events = await collect(adapter.run(thread.id, text, undefined, undefined, undefined, { todoMcp: background() }));
    expect(connect).toHaveBeenCalledWith(thread.id, thread.cwd);
    expect(connection.send).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "continued" });
    expect(request.mock.calls.some(([method]) => method === "turn/start" || method === "mcpServerStatus/list")).toBe(false);
  });

  it.each(["MCP startup failed", "request timeout"])("does not duplicate a create after an ambiguous error: %s", async message => {
    const { adapter, request } = fixture();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method === "thread/start") throw new Error(message);
      return original(method, params);
    });
    await expect(adapter.create({ title: "Ordinary chat", cwd: "/workspace", todoMcp: background() })).rejects.toThrow(message);
    expect(request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
  });
});
