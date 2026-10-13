import { describe, expect, it, vi } from "vitest";
import { DeepSeekHarnessRuntimeAdapter } from "./deepseek-harness-runtime-adapter.js";
import { decodeHarnessHistory } from "./deepseek-harness-codec.js";
import { harnessRecord, type HarnessConnection, type HarnessRecord } from "./deepseek-harness-client.js";

const event = (type: string, seq: number, data: HarnessRecord) => ({ type: "event", event: { type, seq, data } });
const assistant = event("assistant/message", 3, { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "reasoning", text: "考虑" }, { type: "text", text: "回答" }] } });
const nativeRow = { sessionId: "native", cwd: "/repo", updatedAt: 1, projections: { values: { title: "Native" } } };
function mockConnection(frames: HarnessRecord[], rows: HarnessRecord[] = [nativeRow]) {
  const close = vi.fn();
  const request = vi.fn(async (method: string, _args?: HarnessRecord): Promise<unknown> => method === "session/list" ? { items: rows } : method === "goals/get" ? null : {});
  const client: HarnessConnection = { request, follow: vi.fn(async () => ({ values: { async *[Symbol.asyncIterator]() { for (const frame of frames) yield frame; } }, close })), dispose: vi.fn(async () => undefined) };
  return { client, close, request };
}
async function run(frames: HarnessRecord[]) {
  const mock = mockConnection([{ type: "snapshot" }, ...frames]);
  const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
  const events = [];
  for await (const item of adapter.run("native", "hello")) events.push(item);
  return { events, ...mock };
}

describe("DeepSeek Harness native adapter", () => {
  it("loads subagent history and older pages through its durable direct-parent address", async () => {
    const child = { ...nativeRow, origin: "subagent", parentSessionId: "parent",
      projections: { values: { title: "Research", subagent: { mode: "continuable" } } } };
    const address = { kind: "subagent", parentSessionId: "parent", childSessionId: "native", mode: "continuable" };
    const snapshot = { type: "snapshot", cursor: 3, hasMore: true, header: { createdAt: 1 }, records: [assistant] };
    const mock = mockConnection([snapshot], [child]);
    vi.mocked(mock.client.follow).mockImplementation(async request => {
      // Model the Host rejection that caused the reported empty chat.
      const requestedAddress = harnessRecord(request.address);
      if (requestedAddress.kind !== "subagent" || requestedAddress.parentSessionId !== "parent") {
        throw new Error("subagent Sessions require their durable parent address");
      }
      return { values: { async *[Symbol.asyncIterator]() { yield snapshot; } }, close: mock.close };
    });
    mock.request.mockImplementation(async (method, args) => {
      if (method === "session/list") return { items: [child] };
      if (method === "session/page") {
        expect(args?.request).toMatchObject({ address, throughSeq: 3, beforeSeq: 3 });
        return { records: [event("user/message", 1, { role: "user", content: "Research this" })], hasMore: false };
      }
      return {};
    });
    const detail = await new DeepSeekHarnessRuntimeAdapter(mock.client).getSession("native");
    expect(detail.messages.map(message => message.content)).toEqual(["Research this", "回答"]);
    expect(detail).toMatchObject({ nativeGoalSupported: false, nativeModelSelectionSupported: false });
    expect(detail.parentSessionId).toBe("runtime:deepseek-harness:cGFyZW50");
    expect(mock.client.follow).toHaveBeenCalledWith({ address, maxMessages: 100 });
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it("uses unknown mode for listed children whose descriptor is not yet available", async () => {
    const mock = mockConnection([{ type: "snapshot", header: { createdAt: 1 }, records: [] }],
      [{ ...nativeRow, origin: "subagent", parentSessionId: "parent" }]);
    await new DeepSeekHarnessRuntimeAdapter(mock.client).getSession("native");
    expect(mock.client.follow).toHaveBeenCalledWith({ address: {
      kind: "subagent", parentSessionId: "parent", childSessionId: "native", mode: "unknown",
    }, maxMessages: 100 });
  });

  it("keeps ordinary fork history on the ordinary session address", async () => {
    const mock = mockConnection([{ type: "snapshot", header: { createdAt: 1 }, records: [] }],
      [{ ...nativeRow, parentSessionId: "fork-source" }]);
    const detail = await new DeepSeekHarnessRuntimeAdapter(mock.client).getSession("native");
    expect(detail).toMatchObject({ nativeGoalSupported: true, nativeModelSelectionSupported: true });
    expect(mock.client.follow).toHaveBeenCalledWith({ address: { kind: "session", sessionId: "native" }, maxMessages: 100 });
  });

  it("rejects a child without its parent identity before opening an ordinary follower", async () => {
    const mock = mockConnection([], [{ ...nativeRow, origin: "subagent" }]);
    await expect(new DeepSeekHarnessRuntimeAdapter(mock.client).getSession("native"))
      .rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR", message: expect.stringContaining("父会话地址") });
    expect(mock.client.follow).not.toHaveBeenCalled();
  });

  it("routes child continuation and stop through native subagent controls", async () => {
    const mock = mockConnection([{ type: "snapshot" }, assistant, event("turn/end", 4, { reason: { kind: "completed" } })],
      [{ ...nativeRow, origin: "subagent", parentSessionId: "parent",
        projections: { values: { title: "Research", subagent: { mode: "continuable" } } } }]);
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    const events = [];
    for await (const item of adapter.run("native", "Continue")) events.push(item);
    expect(events.at(-1)).toEqual({ type: "done", finalText: "回答" });
    expect(mock.request).toHaveBeenCalledWith("subagents/prompt", { request: {
      requestId: expect.any(String), parentSessionId: "parent", childSessionId: "native",
      mode: "continuable", delivery: "queue", content: [{ type: "text", text: "Continue" }],
    } });
    expect(mock.client.follow).toHaveBeenCalledWith({ address: {
      kind: "subagent", parentSessionId: "parent", childSessionId: "native", mode: "continuable",
    }, maxMessages: 1, assistantStream: true });
    await adapter.abort("native");
    expect(mock.request).toHaveBeenCalledWith("subagents/interruptByParent", {
      parentSessionId: "parent", childSessionId: "native", mode: "continuable",
    });
    expect(mock.request.mock.calls.some(([method]) => ["session/prompt", "session/cancel"].includes(method))).toBe(false);
  });

  it("keeps one-shot child history readable without offering continuation", async () => {
    const mock = mockConnection([{ type: "snapshot", header: { createdAt: 1 }, records: [assistant] }],
      [{ ...nativeRow, origin: "subagent", parentSessionId: "parent",
        projections: { values: { title: "Research", subagent: { mode: "one-shot" } } } }]);
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    expect((await adapter.getSession("native")).canResume).toBe(false);
    await expect(async () => { for await (const _item of adapter.run("native", "Continue")) { /* Drain. */ } })
      .rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    expect(mock.request.mock.calls.some(([method]) => method === "subagents/prompt")).toBe(false);
  });

  it("admits only one run when concurrent sends both await address discovery", async () => {
    const mock = mockConnection([{ type: "snapshot" }, assistant, event("turn/end", 4, { reason: { kind: "completed" } })]);
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    const send = async () => { for await (const _item of adapter.run("native", "Continue")) { /* Drain. */ } };
    const results = await Promise.allSettled([send(), send()]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { code: "SESSION_ALREADY_RUNNING" } });
    expect(mock.request.mock.calls.filter(([method]) => method === "session/prompt")).toHaveLength(1);
  });

  it("does not call ordinary goal APIs or activate writers for child controls", async () => {
    const mock = mockConnection([{ type: "snapshot" }], [{ ...nativeRow, origin: "subagent", parentSessionId: "parent" }]);
    mock.request.mockImplementation(async method => {
      if (method === "session/list") return { items: [{ ...nativeRow, origin: "subagent", parentSessionId: "parent" }] };
      if (method.startsWith("goals/")) throw new Error('session "native" is owned by subagent routing');
      return {};
    });
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    expect(await adapter.getNativeGoal("native")).toBeNull();
    await expect(adapter.mutateNativeGoal("native", { action: "create", objective: "Research" }))
      .rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    expect(mock.client.follow).not.toHaveBeenCalled();
    expect(mock.request.mock.calls.some(([method]) => method.startsWith("goals/"))).toBe(false);
  });

  it("keeps native goal routing errors visible for ordinary sessions", async () => {
    const mock = mockConnection([{ type: "snapshot" }]);
    mock.request.mockImplementation(async method => {
      if (method === "session/list") return { items: [nativeRow] };
      throw new Error("goals/get unavailable");
    });
    await expect(new DeepSeekHarnessRuntimeAdapter(mock.client).getNativeGoal("native"))
      .rejects.toThrow("goals/get unavailable");
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it("preserves ordinary cancellation", async () => {
    const ordinary = mockConnection([]);
    await new DeepSeekHarnessRuntimeAdapter(ordinary.client).abort("native");
    expect(ordinary.request).toHaveBeenCalledWith("session/cancel", { request: { sessionId: "native" } });
  });

  it("keeps child permission values visible without offering ordinary permission writes", async () => {
    const child = { ...nativeRow, origin: "subagent", parentSessionId: "parent",
      projections: { values: { permissions: { currentValue: "read-only" } } } };
    const mock = mockConnection([], [child]);
    mock.request.mockImplementation(async method => method === "session/list" ? { items: [child] }
      : method === "permissionPresets/catalog" ? { options: [{ value: "read-only" }] } : {});
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    expect((await adapter.discoverSessions())[0].nativePermissions).toEqual({ currentValue: "read-only", options: [] });
    await expect(adapter.setNativePermissionPreset("native", "read-only"))
      .rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    expect(mock.request.mock.calls.some(([method]) => method === "commands/execute")).toBe(false);
  });

  it("rejects child model overrides before opening a stream or submitting a prompt", async () => {
    const mock = mockConnection([], [{ ...nativeRow, origin: "subagent", parentSessionId: "parent" }]);
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    await expect(async () => {
      for await (const _item of adapter.run("native", "Continue", undefined, undefined, undefined,
        { model: { id: "deepseek-v4-pro" } })) { /* Drain. */ }
    }).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    expect(mock.client.follow).not.toHaveBeenCalled();
    expect(mock.request.mock.calls.some(([method]) => ["session/selectModel", "subagents/prompt"].includes(method))).toBe(false);
  });

  it("derives pageable workspaces without treating unloaded agents as external writers", async () => {
    const mock = mockConnection([]);
    mock.request.mockImplementation(async () => ({ items: [
      { sessionId: "a", cwd: "/repo/a", updatedAt: 30, agentAvailable: false },
      { sessionId: "b", cwd: "/repo/b", updatedAt: 20 },
      { sessionId: "c", cwd: "/repo/a/", updatedAt: 10 },
    ] }));
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    const first = await adapter.listWorkspaces({ limit: 1 });
    expect(first.data[0]).toMatchObject({ name: "a", roots: ["/repo/a"], source: "derived" });
    const second = await adapter.listWorkspaces({ limit: 1, cursor: first.nextCursor });
    expect(second.data[0].name).toBe("b");
    expect(second.nextCursor).toBeNull();
    const sessions = await adapter.listWorkspaceSessions(first.data[0].workspaceId, { limit: 1 });
    expect(sessions.data[0]).toMatchObject({ nativeSessionId: "a", projectId: first.data[0].workspaceId, occupancy: "available", canResume: true });
    expect((await adapter.listWorkspaceSessionsByPath("/repo/a", { cursor: sessions.nextCursor })).data[0].nativeSessionId).toBe("c");
  });

  it("writes advertised native permissions and requires the durable projection to confirm them", async () => {
    const mock = mockConnection([{ type: "snapshot", cursor: 0, records: [], header: { createdAt: 1 } }]);
    let preset = "workspace-write";
    mock.request.mockImplementation(async (method, args?: HarnessRecord) => {
      if (method === "permissionPresets/catalog") return { options: ["read-only", "workspace-write", "danger-full-access"].map(value => ({ value, name: value })) };
      if (method === "session/list") return { items: [{ sessionId: "native", updatedAt: 1, agentAvailable: false, projections: { values: { permissions: { currentValue: preset } } } }] };
      if (method === "commands/execute") { preset = String(args?.line).split(" ")[1]; return { result: { kind: "success" } }; }
      return {};
    });
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    expect((await adapter.setNativePermissionPreset("native", "read-only")).nativePermissions?.currentValue).toBe("read-only");
    expect(mock.request).toHaveBeenCalledWith("commands/execute", { agentId: "native", line: "/permission read-only", submittedAttachments: [] });
    await expect(adapter.setNativePermissionPreset("native", "full-access")).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    await expect(adapter.setNativePermissionPreset("native", "read-only\n/goal injected")).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    mock.request.mockImplementation(async method => {
      if (method === "permissionPresets/catalog") return { options: [{ value: "workspace-write" }] };
      if (method === "session/list") return { items: [{ sessionId: "native", updatedAt: 1, projections: { values: { permissions: { currentValue: "read-only" } } } }] };
      return { result: { kind: "success" } };
    });
    await expect(adapter.setNativePermissionPreset("native", "workspace-write")).rejects.toThrow("未确认权限更新");
  });

  it("switches permissions on the shared Host while another client is running the session", async () => {
    const mock = mockConnection([{ type: "snapshot" }]);
    let preset = "workspace-write";
    mock.request.mockImplementation(async (method, args?: HarnessRecord) => {
      if (method === "permissionPresets/catalog") return { options: [{ value: "read-only" }] };
      if (method === "commands/execute") { preset = String(args?.line).split(" ")[1]; return { result: { kind: "success" } }; }
      return { items: [{ sessionId: "native", updatedAt: 1, running: true, projections: { values: { permissions: { currentValue: preset } } } }] };
    });
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    await expect(adapter.setNativePermissionPreset("native", "read-only")).resolves.toMatchObject({ nativePermissions: { currentValue: "read-only" }, status: "running" });
    expect(mock.request.mock.calls.some(([method]) => method === "session/cancel")).toBe(false);
  });

  it("reads native goal activation and edits the exact advertised revision without submitting a prompt", async () => {
    const mock = mockConnection([{ type: "snapshot" }]);
    let goal = { id: "goal-native", revision: 3, objective: "old", phase: "active", activation: "disarmed", roundsStarted: 2, maxGoalRounds: 5, createdAt: 1, updatedAt: 2 };
    mock.request.mockImplementation(async (method, args?: HarnessRecord) => {
      if (method === "session/list") return { items: [nativeRow] };
      if (method === "goals/get") return goal;
      if (method === "goals/edit") { goal = { ...goal, revision: 4, ...args?.request as object }; return goal; }
      return {};
    });
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    expect(await adapter.getNativeGoal("native")).toMatchObject({ phase: "active", activation: "disarmed", roundsStarted: 2 });
    expect(await adapter.mutateNativeGoal("native", { action: "edit", ref: { id: goal.id, revision: 3 }, objective: "new", maxGoalRounds: 8 })).toMatchObject({ revision: 4, objective: "new", maxGoalRounds: 8 });
    expect(mock.request).toHaveBeenCalledWith("goals/edit", { agentId: "native", ref: { id: "goal-native", revision: 3 }, request: { objective: "new", maxGoalRounds: 8 } });
    expect(mock.request.mock.calls.some(([method]) => method === "session/prompt")).toBe(false);
  });

  it("uses native create and lifecycle APIs, preserving blocked reasons and clear tombstones", async () => {
    const mock = mockConnection([{ type: "snapshot" }]);
    let goal: HarnessRecord | undefined;
    mock.request.mockImplementation(async (method) => {
      if (method === "session/list") return { items: [nativeRow] };
      if (method === "goals/create") { goal = { id: "g", revision: 1, objective: "finish", phase: "active", activation: "armed", roundsStarted: 0, maxGoalRounds: 4, createdAt: 1, updatedAt: 1 }; return { ref: { id: "g", revision: 1 } }; }
      if (method === "goals/pause") goal = { ...goal, revision: 2, phase: "paused", activation: "disarmed" };
      if (method === "goals/resume") goal = { ...goal, revision: 3, phase: "blocked", activation: "disarmed", blockedReason: { code: "round-limit", message: "轮数耗尽" } };
      if (method === "goals/clear") goal = undefined;
      return goal;
    });
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    expect(await adapter.getNativeGoal("native")).toBeNull();
    expect(await adapter.mutateNativeGoal("native", { action: "create", objective: "finish", maxGoalRounds: 4 })).toMatchObject({ activation: "armed", maxGoalRounds: 4 });
    expect(await adapter.mutateNativeGoal("native", { action: "pause", ref: { id: "g", revision: 1 } })).toMatchObject({ phase: "paused" });
    expect(await adapter.mutateNativeGoal("native", { action: "resume", ref: { id: "g", revision: 2 } })).toMatchObject({ phase: "blocked", blockedReason: { message: "轮数耗尽" } });
    expect(await adapter.mutateNativeGoal("native", { action: "clear", ref: { id: "g", revision: 3 } })).toBeNull();
    expect(mock.close).toHaveBeenCalledTimes(5);
  });

  it("does not report a mutation as successful when the native RPC rejects it", async () => {
    const mock = mockConnection([{ type: "snapshot" }]);
    mock.request.mockImplementation(async method => {
      if (method === "session/list") return { items: [nativeRow] };
      throw new Error("GOAL_STALE_REVISION");
    });
    await expect(new DeepSeekHarnessRuntimeAdapter(mock.client).mutateNativeGoal("native", { action: "pause", ref: { id: "g", revision: 1 } })).rejects.toThrow("GOAL_STALE_REVISION");
    expect(mock.close).toHaveBeenCalledOnce();
  });

  it.each([true, false])("does not duplicate streamed text when committed message precedes end: %s", async (messageFirst) => {
    const live = (frame: HarnessRecord) => ({ type: "assistant-stream", frame: { attemptId: "attempt", ...frame } });
    const end = live({ type: "end", outcome: { kind: "committed", seq: 3 } });
    const { events, close } = await run([
      live({ type: "start", turn: 1, step: 1 }),
      live({ type: "chunk", chunk: { type: "reasoning-delta", text: "考虑", index: 0 } }),
      live({ type: "chunk", chunk: { type: "text-delta", text: "回答", index: 1 } }),
      ...(messageFirst ? [assistant, end] : [end, assistant]),
      event("turn/end", 4, { reason: { kind: "completed" } }),
    ]);
    expect(events.filter(item => item.type === "text_chunk").map(item => item.text).join("")).toBe("回答");
    expect(events.filter(item => item.type === "reasoning_summary_delta").map(item => item.delta).join("")).toBe("考虑");
    expect(events.at(-1)).toEqual({ type: "done", finalText: "回答" });
    expect(events.some(item => item.type === "error")).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves text if only reasoning streamed, and surfaces structured credential errors", async () => {
    const { events } = await run([assistant, event("turn/end", 4, { reason: { kind: "error", error: { code: "MISSING_CREDENTIAL", message: "No API key" } } })]);
    expect(events).toContainEqual({ type: "text_chunk", text: "回答" });
    expect(events).toContainEqual({ type: "error", message: "No API key" });
  });

  it("clears ownership and closes the stream after a broken run", async () => {
    const mock = mockConnection([{ type: "snapshot" }]);
    const adapter = new DeepSeekHarnessRuntimeAdapter(mock.client);
    await expect(async () => { for await (const _item of adapter.run("native", "hello")) { /* Drain. */ } }).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(mock.close).toHaveBeenCalledOnce();
    expect((await adapter.discoverSessions())[0].occupancy).toBe("available");
    expect(mock.request).toHaveBeenCalledWith("session/list", { _request: {} });
  });

  it("maps native cancellation to an aborted turn", async () => {
    const { events } = await run([event("turn/end", 2, { reason: { kind: "aborted" } })]);
    expect(events).toContainEqual({ type: "turn_aborted" });
    expect(events.some(item => item.type === "error")).toBe(false);
  });

  it("replays surface replacements and associates tool calls with the native assistant message", () => {
    const records = [
      event("assistant/message", 1, { turn: 1, step: 1, message: { role: "assistant", content: "old" } }),
      { type: "event", event: { type: "assistant/message", seq: 2, surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 }, data: { turn: 1, step: 1, message: { role: "assistant", content: "new" } } } },
      event("tool/call", 3, { turn: 1, step: 1, callId: "call", name: "bash", arguments: "{\"command\":\"pwd\"}" }),
      event("tool/result", 4, { message: { role: "tool", toolCallId: "call", content: "result" } }),
    ];
    const history = decodeHarnessHistory(records);
    expect(history.messages.map(item => item.content)).toEqual(["new", "result"]);
    expect(history.messages[0].toolCalls?.[0]).toMatchObject({ id: "call", name: "bash", arguments: { command: "pwd" } });
    expect(history.events).toHaveLength(2);
  });
});
