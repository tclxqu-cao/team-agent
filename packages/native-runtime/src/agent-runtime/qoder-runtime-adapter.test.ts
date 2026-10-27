import { describe, expect, it } from "vitest";
import type { AgentEvent, Message } from "@agent/core";
import { QoderClient } from "./qoder-client.js";
import { QoderRuntimeAdapter } from "./qoder-runtime-adapter.js";
import type { NativeRpcConnection } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import type { RuntimeSessionError } from "./types.js";
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
  client(workspaces = { list: async (): Promise<string[]> => [] }) {
    return new QoderClient(this, workspaces, { read: async () => { this.historyReads++; return structuredClone(this.history); } });
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

describe("Qoder native ACP adapter", () => {
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
    expect(loads).toBe(2);
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
    const client = new QoderClient(rpc, { list: async () => [] }, { read: async () => { throw new Error("Corrupt native history"); } });
    await expect(client.read("native-1")).rejects.toThrow("Corrupt native history");
    await expect(collect(client.run("native-1", "Do not send"))).rejects.toThrow("Corrupt native history");
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(2);
    expect(rpc.calls.some(call => call.method === "session/load" || call.method === "session/prompt")).toBe(false);
  });
});
