import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, Message } from "@agent/core";
import { QoderClient } from "./qoder-client.js";
import { QoderRuntimeAdapter } from "./qoder-runtime-adapter.js";
import type { NativeRpcConnection } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import { RuntimeSessionError, type RuntimeModelInfo } from "./types.js";
import type { QoderModelCatalogLoader } from "./qoder-model-catalog.js";
import { encodeUnifiedSessionId } from "./session-id.js";

class RpcFixture implements NativeRpcConnection {
  calls: Array<{ method: string; params: NativeJsonPacket }> = [];
  listener: (method: string, params: NativeJsonPacket) => void = () => {};
  handler: (method: string, params: NativeJsonPacket) => Promise<unknown> = async () => ({});
  prompt: () => Promise<NativeJsonPacket> = async () => {
    this.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "native answer" } });
    return { stopReason: "end_turn" };
  };
  cancel: () => void = () => {};
  disposed = false;
  history: Message[] = [
    { role: "user", content: "native history", historyId: "history-user" },
    { role: "assistant", content: "stored answer", historyId: "history-answer" },
  ];
  historyReads = 0;
  modelCatalog = vi.fn<QoderModelCatalogLoader>(async () => [{ id: "catalog-model", displayName: "Catalog model" }]);
  client(workspaces = { list: async (): Promise<string[]> => [] }) {
    return new QoderClient(this, workspaces, { read: async () => { this.historyReads++; return structuredClone(this.history); } }, this.modelCatalog);
  }
  async request(method: string, params: NativeJsonPacket): Promise<NativeJsonPacket> {
    this.calls.push({ method, params });
    if (method === "session/list") return { sessions: [{ sessionId: "native-1", title: "Original", cwd: "/native/workspace", updatedAt: "2026-10-26T00:00:00Z" }] };
    if (method === "session/new") return { sessionId: "native-1", ...this.options() };
    if (method === "session/resume") return this.options();
    if (method === "session/load") {
      this.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "native history" } });
      this.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stored answer" } });
      return this.options();
    }
    if (method === "session/prompt") return this.prompt();
    return {};
  }
  options() { return { models: { currentModelId: "native-model", availableModels: [{ modelId: "native-model", name: "Native model" }] }, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Ask" }] } }; }
  update(update: NativeJsonPacket) { this.listener("session/update", { sessionId: "native-1", update }); }
  async notify(method: string, params: NativeJsonPacket) { this.calls.push({ method, params }); this.cancel(); }
  onNotification(listener: typeof this.listener) { this.listener = listener; return () => {}; }
  onRequest(handler: typeof this.handler) { this.handler = handler; }
  onFailure(_listener: (error: RuntimeSessionError) => void) { return () => {}; }
  async dispose() { this.disposed = true; }
}

async function collect(events: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of events) result.push(event); return result; }

describe("Qoder cwd-scoped discovery", () => {
  it("queries every native workspace and paginates within each cwd without duplicate sessions", async () => {
    const rpc = new RpcFixture();
    const original = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (method !== "session/list") return original(method, params);
      rpc.calls.push({ method, params });
      const row = (sessionId: string, cwd: string, updatedAt = "2026-10-27T00:00:00Z") => ({ sessionId, cwd, updatedAt });
      if (params.cwd === "/repo/a") return params.cursor
        ? { sessions: [row("a-2", "/repo/a")] }
        : { sessions: [row("a-1", "/repo/a")], nextCursor: "a-next" };
      if (params.cwd === "/repo/b") return { sessions: [row("a-1", "/repo/a", "2026-10-26T00:00:00Z"), row("b-1", "/repo/b")] };
      return { sessions: [] };
    };
    const client = rpc.client({ list: async () => ["/repo/a", "/repo/b"] });
    expect((await client.list()).map(row => row.id)).toEqual(["a-1", "a-2", "b-1"]);
    expect(rpc.calls).toContainEqual({ method: "session/list", params: { cwd: "/repo/a", cursor: "a-next" } });
    expect(rpc.calls.some(call => ["session/load", "session/new", "session/prompt"].includes(call.method))).toBe(false);
    expect((await client.read("a-1")).session.updated).toBe("2026-10-27T00:00:00.000Z");
  });

  it("discovers externally added and removed roots on the next refresh", async () => {
    const rpc = new RpcFixture();
    let roots = ["/repo/first"];
    rpc.request = async (method, params) => method === "session/list"
      ? { sessions: roots.includes(String(params.cwd)) ? [{ sessionId: String(params.cwd), cwd: params.cwd }] : [] }
      : {};
    const client = rpc.client({ list: async () => roots });
    expect((await client.list()).map(row => row.cwd)).toEqual(["/repo/first"]);
    roots = ["/repo/second"];
    expect((await client.list()).map(row => row.cwd)).toEqual(["/repo/second"]);
  });
});

describe("Qoder session-independent model discovery", () => {
  it("lists models with no sessions and never calls ACP, workspaces or history", async () => {
    const rpc = new RpcFixture();
    const workspaces = { list: vi.fn(async (): Promise<string[]> => []) };
    rpc.request = vi.fn(async () => { throw new Error("Model enumeration must not call ACP"); });
    const client = rpc.client(workspaces);
    const adapter = new QoderRuntimeAdapter(client);
    await expect(adapter.listModels()).resolves.toEqual([{ id: "catalog-model", displayName: "Catalog model" }]);
    expect(rpc.modelCatalog).toHaveBeenCalledOnce();
    expect(rpc.request).not.toHaveBeenCalled();
    expect(workspaces.list).not.toHaveBeenCalled();
    expect(rpc.historyReads).toBe(0);
    expect(rpc.calls).toEqual([]);
  });

  it("coalesces concurrent catalog calls and caches only the nonempty result", async () => {
    const rpc = new RpcFixture();
    let release!: (models: RuntimeModelInfo[]) => void;
    rpc.modelCatalog.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const client = rpc.client();
    const first = client.listModels();
    const second = client.listModels();
    const third = client.listModels();
    expect(rpc.modelCatalog).toHaveBeenCalledOnce();
    const models = [{ id: "Auto", displayName: "Auto" }];
    release(models);
    const results = await Promise.all([first, second, third]);
    for (const result of results) expect(result).toEqual(models);
    expect(results[0]).not.toBe(results[1]);
    models.push({ id: "Source mutation", displayName: "Source mutation" });
    results[0].length = 0;
    await expect(client.listModels()).resolves.toEqual([{ id: "Auto", displayName: "Auto" }]);
    expect(rpc.modelCatalog).toHaveBeenCalledOnce();
    expect(rpc.calls).toEqual([]);
  });

  it("shares a catalog failure but retries on the next request without opening a session", async () => {
    const rpc = new RpcFixture();
    let reject!: (reason: Error) => void;
    rpc.modelCatalog.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const client = rpc.client();
    const first = client.listModels();
    const second = client.listModels();
    const error = new RuntimeSessionError("Qoder catalog unavailable", "RUNTIME_UNAVAILABLE");
    const settled = Promise.allSettled([first, second]);
    reject(error);
    expect(await settled).toEqual([{ status: "rejected", reason: error }, { status: "rejected", reason: error }]);
    await expect(client.listModels()).resolves.toEqual([{ id: "catalog-model", displayName: "Catalog model" }]);
    await client.listModels();
    expect(rpc.modelCatalog).toHaveBeenCalledTimes(2);
    expect(rpc.calls).toEqual([]);
  });

  it("retries an empty catalog instead of caching it or falling back to session discovery", async () => {
    const rpc = new RpcFixture();
    rpc.modelCatalog.mockResolvedValueOnce([]);
    const client = rpc.client();
    await expect(client.listModels()).resolves.toEqual([]);
    await expect(client.listModels()).resolves.toEqual([{ id: "catalog-model", displayName: "Catalog model" }]);
    expect(rpc.modelCatalog).toHaveBeenCalledTimes(2);
    expect(rpc.calls).toEqual([]);
    expect(rpc.historyReads).toBe(0);
  });

  it("keeps models returned by normal session creation without running the catalog", async () => {
    const rpc = new RpcFixture();
    const client = rpc.client();
    await client.create({ title: "Owned", cwd: "/native/workspace" });
    const calls = [...rpc.calls];
    await expect(client.listModels()).resolves.toEqual([{ id: "native-model", displayName: "Native model", description: undefined }]);
    expect(rpc.modelCatalog).not.toHaveBeenCalled();
    expect(rpc.calls).toEqual(calls);
  });

  it("keeps models returned by a normal resume without running the catalog", async () => {
    const rpc = new RpcFixture();
    const client = rpc.client();
    await client.read("native-1");
    const calls = [...rpc.calls];
    await expect(client.listModels()).resolves.toEqual([{ id: "native-model", displayName: "Native model", description: undefined }]);
    expect(rpc.modelCatalog).not.toHaveBeenCalled();
    expect(rpc.calls).toEqual(calls);
  });

  it("keeps the CLI catalog stable and maps a preset only from the current session's advertised ID", async () => {
    const rpc = new RpcFixture();
    rpc.modelCatalog.mockResolvedValue([{ id: "Auto", displayName: "Auto" }]);
    rpc.options = () => ({ models: { currentModelId: "auto", availableModels: [{ modelId: "auto", name: "Auto" }] }, modes: { currentModeId: "default", availableModes: [] } });
    const client = rpc.client();
    await expect(client.listModels()).resolves.toEqual([{ id: "Auto", displayName: "Auto" }]);
    await client.create({ title: "Owned", cwd: "/native/workspace" });
    await expect(client.listModels()).resolves.toEqual([{ id: "Auto", displayName: "Auto" }]);
    await collect(client.run("native-1", "First", undefined, { model: { id: "Auto" } }));
    expect(rpc.calls.find(call => call.method === "session/set_model")).toEqual({
      method: "session/set_model", params: { sessionId: "native-1", modelId: "auto" },
    });
    expect(rpc.modelCatalog).toHaveBeenCalledOnce();
  });

  it("does not discard a nonempty catalog when a session returns no models", async () => {
    const rpc = new RpcFixture();
    rpc.options = () => ({ models: { currentModelId: "", availableModels: [] }, modes: { currentModeId: "default", availableModes: [] } });
    const client = rpc.client();
    await client.listModels();
    await client.create({ title: "Owned", cwd: "/native/workspace" });
    await expect(client.listModels()).resolves.toEqual([{ id: "catalog-model", displayName: "Catalog model" }]);
    expect(rpc.modelCatalog).toHaveBeenCalledOnce();
  });
});

describe("Qoder native ACP adapter", () => {
  it("reads a newly created blank session and sends its first prompt without resuming a nonexistent transcript", async () => {
    const rpc = new RpcFixture();
    const request = rpc.request.bind(rpc);
    let persisted = false;
    rpc.request = async (method, params) => {
      if (method === "session/resume") throw new RuntimeSessionError(persisted ? "Session is already open (state=active)" : "Invalid session identifier", "NATIVE_PROTOCOL_ERROR");
      return request(method, params);
    };
    const client = new QoderClient(rpc, { list: async () => [] }, { read: async () => {
      if (!persisted) throw new RuntimeSessionError("Qoder session not found", "SESSION_NOT_FOUND");
      return [{ role: "user", content: "First prompt", historyId: "first-user" }, { role: "assistant", content: "First answer", historyId: "first-answer" }];
    } }, rpc.modelCatalog);
    const adapter = new QoderRuntimeAdapter(client);
    await adapter.create({ title: "Blank draft", cwd: "/native/workspace" });
    expect((await adapter.getSession("native-1")).messages).toEqual([]);
    expect((await adapter.getSession("native-1")).messages).toEqual([]);
    expect(rpc.calls.some(call => call.method === "session/resume")).toBe(false);
    rpc.prompt = async () => {
      persisted = true;
      rpc.update({ sessionUpdate: "agent_message_chunk", messageId: "first-answer", content: { text: "First answer" } });
      return { stopReason: "end_turn" };
    };
    expect((await collect(adapter.run("native-1", "First prompt"))).at(-1)).toEqual({ type: "done", finalText: "First answer" });
    expect((await adapter.getSession("native-1")).messages.map(message => message.historyId)).toEqual(["first-user", "first-answer"]);
    await adapter.getSession("native-1");
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(0);
    expect(rpc.calls.filter(call => call.method === "session/new")).toHaveLength(1);
  });

  it("does not treat corrupt fresh-session history as an empty transcript", async () => {
    const rpc = new RpcFixture();
    const client = new QoderClient(rpc, { list: async () => [] }, { read: async () => { throw new Error("Corrupt draft history"); } }, rpc.modelCatalog);
    await client.create({ title: "Blank draft", cwd: "/native/workspace" });
    await expect(client.read("native-1")).rejects.toThrow("Corrupt draft history");
    await expect(collect(client.run("native-1", "Do not send"))).rejects.toThrow("Corrupt draft history");
    expect(rpc.calls.some(call => call.method === "session/resume")).toBe(false);
    expect(rpc.calls.some(call => call.method === "session/prompt")).toBe(false);
  });

  it("coalesces overlapping native resumes but still reads fresh history on the next refresh", async () => {
    const rpc = new RpcFixture();
    const original = rpc.request.bind(rpc);
    let active = false;
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    rpc.request = async (method, params) => {
      if (method !== "session/resume") return original(method, params);
      if (active) throw new Error("Native resume cannot overlap");
      active = true;
      loads++;
      try { await gate; return await original(method, params); }
      finally { active = false; }
    };
    const client = rpc.client();
    await client.list();
    const first = client.read("native-1");
    const second = client.read("native-1");
    await new Promise(resolve => setImmediate(resolve));
    expect(loads).toBe(1);
    release();
    const results = await Promise.all([first, second]);
    for (const result of results) expect(result.messages).toHaveLength(2);
    await client.read("native-1");
    expect(loads).toBe(1);
    expect(rpc.historyReads).toBe(2);
  });

  it("creates native identity, reads native transcript history and lists native models only", async () => {
    const rpc = new RpcFixture(); const adapter = new QoderRuntimeAdapter(rpc.client());
    const created = await adapter.create({ title: "Owned", cwd: "/native/workspace", projectId: "project" });
    expect(created).toMatchObject({ id: encodeUnifiedSessionId("qoder", "native-1"), agentType: "qoder", projectId: "project" });
    expect(await adapter.getSession("native-1")).toMatchObject({ messages: [{ role: "user", content: "native history" }, { role: "assistant", content: "stored answer" }], events: [] });
    expect(await adapter.listModels()).toEqual([{ id: "native-model", displayName: "Native model", description: undefined }]);
    expect(rpc.calls[0]).toMatchObject({ method: "initialize", params: { clientCapabilities: { terminal: false, fs: { readTextFile: false, writeTextFile: false } } } });
    expect(rpc.calls.some(call => call.method === "session/load")).toBe(false);
  });

  it("uses the same native session for subsequent turns and projects streamed tools and text", async () => {
    const rpc = new RpcFixture(); const adapter = new QoderRuntimeAdapter(rpc.client());
    await adapter.create({ title: "Owned", cwd: "/native/workspace" });
    rpc.prompt = async () => {
      rpc.update({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", rawInput: { file: "README" } });
      rpc.update({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "native result" } }] });
      rpc.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      rpc.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
      return { stopReason: "end_turn" };
    };
    const first = await collect(adapter.run("native-1", "first", undefined, undefined, undefined, { model: { id: "native-model" } }));
    const second = await collect(adapter.run("native-1", "second"));
    expect(first.map(event => event.type)).toEqual(["tool_call", "tool_result", "reasoning_summary_delta", "text_chunk", "done"]);
    expect(second.at(-1)).toEqual({ type: "done", finalText: "answer" });
    expect(rpc.calls.filter(call => call.method === "session/new")).toHaveLength(1);
    expect(rpc.calls.filter(call => call.method === "session/prompt").map(call => call.params.sessionId)).toEqual(["native-1", "native-1"]);
  });

  it("awaits the selected opaque model before every turn's prompt", async () => {
    const rpc = new RpcFixture();
    const adapter = new QoderRuntimeAdapter(rpc.client());
    await adapter.create({ title: "Owned", cwd: "/native/workspace" });
    const request = rpc.request.bind(rpc);
    let release!: () => void;
    const selected = new Promise<void>(resolve => { release = resolve; });
    rpc.request = async (method, params) => {
      if (method === "session/set_model") {
        const result = await request(method, params);
        await selected;
        return result;
      }
      return request(method, params);
    };
    const first = collect(adapter.run("native-1", "First", undefined, undefined, undefined, { model: { id: "magpie/group/gpt-6" } }));
    await new Promise(resolve => setImmediate(resolve));
    expect(rpc.calls.at(-1)).toEqual({ method: "session/set_model", params: { sessionId: "native-1", modelId: "magpie/group/gpt-6" } });
    expect(rpc.calls.some(call => call.method === "session/prompt")).toBe(false);
    release();
    expect((await first).at(-1)?.type).toBe("done");
    await collect(adapter.run("native-1", "Second", undefined, undefined, undefined, { model: { id: "Auto" } }));
    expect(rpc.calls.filter(call => call.method === "session/set_model" || call.method === "session/prompt")).toEqual([
      { method: "session/set_model", params: { sessionId: "native-1", modelId: "magpie/group/gpt-6" } },
      { method: "session/prompt", params: { sessionId: "native-1", prompt: [{ type: "text", text: "First" }] } },
      { method: "session/set_model", params: { sessionId: "native-1", modelId: "Auto" } },
      { method: "session/prompt", params: { sessionId: "native-1", prompt: [{ type: "text", text: "Second" }] } },
    ]);
  });

  it.each([
    { selected: "Auto", models: [{ modelId: "Auto", name: "Exact" }, { modelId: "auto", name: "Auto" }], expected: "Auto" },
    { selected: "Auto", models: [{ modelId: "one", name: "Auto" }, { modelId: "two", name: "Auto" }], expected: "Auto" },
    { selected: "AUTO", models: [{ modelId: "auto", name: "Auto" }], expected: "AUTO" },
    { selected: "magpie/group/model", models: [{ modelId: "native", name: "Other" }], expected: "magpie/group/model" },
  ])("prefers exact model IDs and never guesses a missing or ambiguous name: $selected", async ({ selected, models, expected }) => {
    const rpc = new RpcFixture();
    rpc.options = () => ({ models: { currentModelId: "", availableModels: models }, modes: { currentModeId: "default", availableModes: [] } });
    const client = rpc.client();
    await client.create({ title: "Owned", cwd: "/native/workspace" });
    await collect(client.run("native-1", "Question", undefined, { model: { id: selected } }));
    expect(rpc.calls.find(call => call.method === "session/set_model")?.params.modelId).toBe(expected);
  });

  it("keeps model name resolution scoped to the session instead of the most recently opened session", async () => {
    const rpc = new RpcFixture();
    const request = rpc.request.bind(rpc);
    rpc.request = async (method, params) => {
      if (method === "session/new") {
        rpc.calls.push({ method, params });
        return { sessionId: String(params.cwd), models: { availableModels: [{ modelId: `${params.cwd}-auto`, name: "Auto" }] } };
      }
      return request(method, params);
    };
    const client = rpc.client();
    await client.create({ title: "A", cwd: "/a" });
    await client.create({ title: "B", cwd: "/b" });
    await collect(client.run("/a", "First", undefined, { model: { id: "Auto" } }));
    await collect(client.run("/b", "Second", undefined, { model: { id: "Auto" } }));
    expect(rpc.calls.filter(call => call.method === "session/set_model")).toEqual([
      { method: "session/set_model", params: { sessionId: "/a", modelId: "/a-auto" } },
      { method: "session/set_model", params: { sessionId: "/b", modelId: "/b-auto" } },
    ]);
  });

  it("does not prompt or silently use another model when native model selection is rejected", async () => {
    const rpc = new RpcFixture();
    const adapter = new QoderRuntimeAdapter(rpc.client());
    await adapter.create({ title: "Owned", cwd: "/native/workspace" });
    const request = rpc.request.bind(rpc);
    const error = new RuntimeSessionError("Native model rejected", "NATIVE_PROTOCOL_ERROR");
    rpc.request = async (method, params) => {
      if (method === "session/set_model") {
        rpc.calls.push({ method, params });
        throw error;
      }
      return request(method, params);
    };
    await expect(collect(adapter.run("native-1", "Never send", undefined, undefined, undefined, { model: { id: "group/rejected-model" } }))).rejects.toBe(error);
    expect(rpc.calls.at(-1)).toEqual({ method: "session/set_model", params: { sessionId: "native-1", modelId: "group/rejected-model" } });
    expect(rpc.calls.some(call => call.method === "session/prompt")).toBe(false);
    expect(rpc.calls.filter(call => call.method === "session/new")).toHaveLength(1);
  });

  it("keeps reasoning segments separate across text and tool boundaries", async () => {
    const rpc = new RpcFixture(); const client = rpc.client();
    rpc.prompt = async () => {
      rpc.update({ sessionUpdate: "agent_thought_chunk", content: { text: "Inspect " } });
      rpc.update({ sessionUpdate: "agent_thought_chunk", content: { text: "files" } });
      rpc.update({ sessionUpdate: "agent_message_chunk", content: { text: "Checking" } });
      rpc.update({ sessionUpdate: "tool_call", toolCallId: "read", title: "Read", rawInput: {} });
      rpc.update({ sessionUpdate: "agent_thought_chunk", content: { text: "Verify" } });
      rpc.update({ sessionUpdate: "agent_message_chunk", content: { text: "Done" } });
      return { stopReason: "end_turn" };
    };
    const events = await collect(client.run("native-1", "Question"));
    const thoughts = events.filter(event => event.type === "reasoning_summary_delta");
    expect(thoughts).toHaveLength(3);
    expect(thoughts[0].itemId).toBe(thoughts[1].itemId);
    expect(thoughts[2].itemId).not.toBe(thoughts[0].itemId);
    expect(events.at(-1)).toEqual({ type: "done", finalText: "CheckingDone" });
  });

  it("does not auto-approve reverse permissions and keeps invalid answers pending", async () => {
    const rpc = new RpcFixture(); const client = rpc.client();
    await client.create({ title: "Owned", cwd: "/native/workspace" });
    let outcome: unknown;
    rpc.prompt = async () => { outcome = await rpc.handler("session/request_permission", { sessionId: "native-1", toolCall: { title: "Write file" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Deny", kind: "reject_once" }] }); return { stopReason: "end_turn" }; };
    const iterator = client.run("native-1", "request")[Symbol.asyncIterator]();
    const next = await iterator.next();
    expect(next.value.type).toBe("ask_user"); expect(outcome).toBeUndefined();
    if (next.value.type !== "ask_user") throw new Error("Expected native approval");
    await expect(client.answerQuestion(next.value.questionId, { answer: "unknown" })).rejects.toMatchObject({ code: "QUESTION_ANSWER_FAILED" });
    await client.answerQuestion(next.value.questionId, { answer: "Deny", selectedIndices: [1] });
    while (!(await iterator.next()).done) {}
    expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(await rpc.handler("session/request_permission", { sessionId: "native-1", options: [{ optionId: "yes" }] })).toEqual({ outcome: { outcome: "cancelled" } });
    await expect(rpc.handler("fs/write_text_file", {})).rejects.toThrow("Unsupported");
  });

  it("sends native cancellation and never converts it to success", async () => {
    const rpc = new RpcFixture(); const client = rpc.client();
    await client.create({ title: "Owned", cwd: "/native/workspace" });
    rpc.prompt = () => new Promise(resolve => { rpc.update({ sessionUpdate: "agent_message_chunk", content: { text: "partial" } }); rpc.cancel = () => resolve({ stopReason: "cancelled" }); });
    const iterator = client.run("native-1", "long turn")[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("text_chunk");
    await client.abort("native-1");
    expect((await iterator.next()).value).toEqual({ type: "turn_aborted" });
    expect((await iterator.next()).done).toBe(true);
    expect(rpc.calls.at(-1)).toMatchObject({ method: "session/cancel", params: { sessionId: "native-1" } });
  });

  it("restores a broker draft without inventing native history or creating a replacement session", async () => {
    const rpc = new RpcFixture(); const client = rpc.client();
    client.restoreDraft({ id: "native-1", title: "Draft", cwd: "/native/workspace", created: "2026-10-26T00:00:00Z", updated: "2026-10-26T00:00:00Z" });
    await client.read("native-1");
    expect(rpc.calls.map(call => call.method)).toEqual(["initialize", "session/resume"]);
    await client.dispose(); expect(rpc.disposed).toBe(true);
  });

  it("keeps old document replies before newer questions and refreshes external messages", async () => {
    const rpc = new RpcFixture(); const client = rpc.client();
    rpc.history = [
      { role: "user", content: "Edit the document", historyId: "old-user" },
      { role: "assistant", content: "Document completed", historyId: "old-answer" },
      { role: "user", content: "Which model?", historyId: "new-user" },
    ];
    expect((await client.read("native-1")).messages.map(message => message.historyId)).toEqual(["old-user", "old-answer", "new-user"]);
    rpc.history.push({ role: "assistant", content: "Queue recovery exceeded", historyId: "new-answer" });
    expect((await client.read("native-1")).messages.at(-1)?.historyId).toBe("new-answer");
    expect(rpc.calls.some(call => call.method === "session/load")).toBe(false);
  });

  it("does not project known historical messages, reasoning or tools into a new turn", async () => {
    const rpc = new RpcFixture(); const client = rpc.client();
    rpc.history.push({ role: "assistant", content: "Old document reply", historyId: "old-answer", toolCalls: [{ id: "old-tool", name: "Read", arguments: {} }] });
    await client.read("native-1");
    rpc.prompt = async () => {
      rpc.update({ sessionUpdate: "agent_message_chunk", messageId: "old-answer", content: { text: "Old document reply" } });
      rpc.update({ sessionUpdate: "agent_thought_chunk", messageId: "old-answer", content: { text: "Old reasoning" } });
      rpc.update({ sessionUpdate: "tool_call", toolCallId: "old-tool", title: "Read", rawInput: {} });
      rpc.update({ sessionUpdate: "tool_call_update", toolCallId: "old-tool", status: "completed", content: { text: "Old result" } });
      rpc.update({ sessionUpdate: "agent_thought_chunk", messageId: "new-answer", content: { text: "New reasoning" } });
      rpc.update({ sessionUpdate: "agent_message_chunk", messageId: "new-answer", content: { text: "New answer" } });
      return { stopReason: "end_turn" };
    };
    const events = await collect(client.run("native-1", "Which model?"));
    expect(events.map(event => event.type)).toEqual(["reasoning_summary_delta", "text_chunk", "done"]);
    expect(events.at(-1)).toEqual({ type: "done", finalText: "New answer" });
    expect(JSON.stringify(events)).not.toContain("Old");
  });

  it("keeps committed native history while a turn runs instead of replacing the writer", async () => {
    const rpc = new RpcFixture(); const client = rpc.client();
    await client.read("native-1");
    let finish!: (result: NativeJsonPacket) => void;
    rpc.prompt = () => new Promise(resolve => { finish = resolve; rpc.update({ sessionUpdate: "agent_message_chunk", messageId: "live", content: { text: "Partial" } }); });
    const iterator = client.run("native-1", "Question")[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("text_chunk");
    expect((await client.read("native-1")).messages).toEqual(rpc.history);
    expect(rpc.historyReads).toBe(1);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
    finish({ stopReason: "end_turn" });
    while (!(await iterator.next()).done) {}
  });

  it("fails closed when native history cannot be read instead of prompting with an incomplete snapshot", async () => {
    const rpc = new RpcFixture();
    const client = new QoderClient(rpc, { list: async () => [] }, { read: async () => { throw new Error("Corrupt native history"); } }, rpc.modelCatalog);
    await expect(client.read("native-1")).rejects.toThrow("Corrupt native history");
    await expect(collect(client.run("native-1", "Do not send"))).rejects.toThrow("Corrupt native history");
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
    expect(rpc.calls.some(call => call.method === "session/load" || call.method === "session/prompt")).toBe(false);
  });
});
