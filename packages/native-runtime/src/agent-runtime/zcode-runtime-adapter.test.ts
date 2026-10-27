import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent/core";
import { ZCodeClient, decodeZCodeHistory } from "./zcode-client.js";
import { ZCodeRuntimeAdapter } from "./zcode-runtime-adapter.js";
import type { NativeRpcConnection } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";
import type { RuntimeSessionError } from "./types.js";
import { encodeUnifiedSessionId } from "./session-id.js";

class ZCodeFixture implements NativeRpcConnection {
  calls: Array<{ method: string; params: NativeJsonPacket }> = [];
  listener: (method: string, params: NativeJsonPacket) => void = () => {};
  handler: (method: string, params: NativeJsonPacket) => Promise<unknown> = async () => ({});
  sequence = 10;
  prompt: () => Promise<void> = async () => {
    this.emit("model.streaming", { kind: "text_delta", delta: "native answer" });
    this.emit("turn.completed", {});
  };
  session = { sessionId: "sess_native", title: "Native ZCode", workspace: { workspacePath: "/native/zcode", workspaceKey: "/native/zcode" }, createdAt: 1792972800000, updatedAt: 1792972800000, status: "idle" };
  models: NativeJsonPacket[] = [{ ref: { providerId: "zcode-native", modelId: "native-model" }, label: "Native model", providerLabel: "Native provider" }];
  async request(method: string, params: NativeJsonPacket): Promise<NativeJsonPacket> {
    this.calls.push({ method, params });
    if (method === "session/list") return { sessions: [this.session] };
    if (method === "session/create" || method === "session/resume") {
      const preferences = await this.handler("session/requestRuntimePreferences", { sessionId: "sess_native", scope: "runtime-materialization" });
      expect(preferences).toMatchObject({ askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: "preflight-v1" });
      return this.snapshot();
    }
    if (method === "session/read") return { ...this.snapshot(), settings: { model: { available: [] } } };
    if (method === "session/messages") return { messages: [{ info: { id: "native-message", role: "user" }, parts: [{ type: "text", text: "native history" }] }] };
    if (method === "session/subscribe") return { eventSeq: this.sequence, events: [], sessionId: "sess_native" };
    if (method === "session/send") { void this.prompt(); return { accepted: true, sessionId: "sess_native" }; }
    return {};
  }
  snapshot() { return { session: this.session, settings: { model: { available: this.models } } }; }
  emit(type: string, payload: NativeJsonPacket) { this.listener("session/event", { sessionId: "sess_native", seq: ++this.sequence, type, payload, turnId: "native-turn" }); }
  async notify() {}
  onNotification(listener: typeof this.listener) { this.listener = listener; return () => {}; }
  onRequest(handler: typeof this.handler) { this.handler = handler; }
  onFailure(_listener: (error: RuntimeSessionError) => void) { return () => {}; }
  async dispose() {}
}
async function collect(source: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of source) events.push(event); return events; }

describe("ZCode native-visible child discovery", () => {
  class ChildFixture extends ZCodeFixture {
    childIds = ["sess_child"];
    childTitle = "Child";
    override async request(method: string, params: NativeJsonPacket): Promise<NativeJsonPacket> {
      if (method === "session/subagents") {
        this.calls.push({ method, params });
        return { childSessionIds: this.childIds, running: [], ended: { total: this.childIds.length, items: [] } };
      }
      if (method === "session/list" && Array.isArray(params.sessionIds)) {
        this.calls.push({ method, params });
        return { sessions: params.sessionIds.filter(id => this.childIds.includes(String(id))).map(id => ({
          ...this.session, sessionId: id, parentSessionId: this.session.sessionId, sessionKind: "subagent_child", title: this.childTitle,
        })) };
      }
      return super.request(method, params);
    }
  }

  it("retains native parent identity and marks child sessions read-only without resuming them", async () => {
    const rpc = new ChildFixture();
    const sessions = await new ZCodeRuntimeAdapter(new ZCodeClient(rpc)).discoverSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[1]).toMatchObject({ nativeSessionId: "sess_child", parentSessionId: encodeUnifiedSessionId("zcode", "sess_native"), readOnly: true, canResume: false });
    expect(rpc.calls.some(call => ["session/resume", "session/create", "session/send"].includes(call.method))).toBe(false);
  });

  it("refreshes child metadata and re-discovers children when the parent changes", async () => {
    const rpc = new ChildFixture();
    const client = new ZCodeClient(rpc);
    await client.list();
    rpc.childTitle = "Externally updated";
    expect((await client.list()).find(row => row.id === "sess_child")?.title).toBe("Externally updated");
    expect(rpc.calls.filter(call => call.method === "session/subagents")).toHaveLength(1);
    rpc.session.updatedAt += 1;
    rpc.childIds.push("sess_new_child");
    expect((await client.list()).map(row => row.id)).toContain("sess_new_child");
    rpc.childIds = [];
    expect((await client.list()).map(row => row.id)).toEqual(["sess_native"]);
  });
});

describe("ZCode native NDJSON adapter", () => {
  it("reads externally appended native history again even while the loaded session stays idle", async () => {
    const rpc = new ZCodeFixture();
    const request = rpc.request.bind(rpc);
    let content = "Initial";
    rpc.request = async (method, params) => method === "session/messages"
      ? { messages: [{ info: { id: "latest", role: "assistant" }, parts: [{ type: "text", text: content }] }] }
      : request(method, params);
    const client = new ZCodeClient(rpc);
    expect((await client.read("sess_native")).messages[0].content).toBe("Initial");
    content = "Updated in the native app";
    expect((await client.read("sess_native")).messages[0].content).toBe(content);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
  });
  it("persists a real native session immediately instead of returning a lost deferred session", async () => {
    const rpc = new ZCodeFixture(); const adapter = new ZCodeRuntimeAdapter(new ZCodeClient(rpc));
    const created = await adapter.create({ title: "Owned", cwd: "/native/zcode" });
    expect(created.agentType).toBe("zcode"); expect(created.nativeSessionId).toBe("sess_native");
    expect(rpc.calls[0]).toMatchObject({ method: "session/create", params: { persistence: "immediate", workspace: { workspacePath: "/native/zcode", workspaceKey: "/native/zcode" } } });
    expect((await adapter.getSession("sess_native")).messages).toMatchObject([{ role: "user", content: "native history" }]);
    expect(await adapter.listModels()).toEqual([{ id: "native-model", providerID: "zcode-native", displayName: "Native model", providerDisplayName: "Native provider", description: undefined }]);
  });

  it("streams native events once per sequence and retains provider/model identity per turn", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => {
      rpc.emit("model.streaming", { kind: "text_delta", delta: "answer" });
      rpc.listener("session/event", { sessionId: "sess_native", seq: rpc.sequence, type: "model.streaming", payload: { kind: "text_delta", delta: "DUPLICATE" } });
      rpc.emit("tool.updated", { kind: "started", toolCallId: "tool", toolName: "Read", input: { path: "README" } });
      rpc.emit("tool.updated", { kind: "result", toolCallId: "tool", output: "native result" });
      rpc.emit("turn.completed", {});
    };
    const events = await collect(client.run("sess_native", "request", undefined, { model: { providerID: "zcode-native", id: "native-model" } }));
    expect(events.map(event => event.type)).toEqual(["text_chunk", "tool_call", "tool_result", "done"]);
    expect(events.at(-1)).toEqual({ type: "done", finalText: "answer" });
    expect(rpc.calls.find(call => call.method === "session/send")?.params).toMatchObject({ sessionId: "sess_native", modelSelection: { providerId: "zcode-native", modelId: "native-model" } });
    await collect(client.run("sess_native", "second turn"));
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(1);
  });

  it("refreshes an empty catalog from an idle native session even when it is already loaded", async () => {
    const rpc = new ZCodeFixture(); rpc.models = [];
    const client = new ZCodeClient(rpc);
    await client.read("sess_native");
    rpc.models = [{ ref: { providerId: "native-provider", modelId: "new-model" }, label: "New native model" }];
    expect(await client.listModels()).toMatchObject([{ id: "new-model", providerID: "native-provider" }]);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(2);
    await client.read("sess_native");
    expect(await client.listModels()).toMatchObject([{ id: "new-model", providerID: "native-provider" }]);
    expect(rpc.calls.filter(call => call.method === "session/resume")).toHaveLength(2);
  });

  it("streams retry progress once per native sequence and still waits for the actual turn result", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => {
      rpc.emit("session.updated", { type: "model_request_started", attempt: 1, maxAttempts: 11 });
      rpc.emit("session.updated", { type: "model_retry_scheduled", nextAttempt: 2, maxAttempts: 11, message: "Native quota limit", delayMs: 50_030 });
      rpc.listener("session/event", { sessionId: "sess_native", seq: rpc.sequence, type: "session.updated", payload: { type: "model_retry_scheduled", message: "DUPLICATE" } });
      rpc.listener("session/event", { sessionId: "another-session", seq: 999, type: "session.updated", payload: { type: "model_retry_scheduled", message: "FOREIGN" } });
      rpc.emit("session.updated", { type: "model_request_started", attempt: 2, maxAttempts: 11 });
      rpc.emit("model.streaming", { kind: "text_delta", delta: "Recovered native response" });
      rpc.emit("session.updated", { type: "model_request_completed", attempt: 2, maxAttempts: 11 });
      rpc.emit("turn.completed", {});
    };

    const events = await collect(client.run("sess_native", "request"));
    expect(events.map(event => event.type)).toEqual(["runtime_progress", "runtime_progress", "runtime_progress", "text_chunk", "runtime_progress", "done"]);
    expect(events[1]).toMatchObject({ phase: "retry", label: "ZCode 请求重试 2/11", detail: "Native quota limit\n原生运行时将在 51 秒后重试" });
    expect(events[2]).not.toHaveProperty("detail");
    expect(events.at(-1)).toEqual({ type: "done", finalText: "Recovered native response" });
    expect(JSON.stringify(events)).not.toMatch(/DUPLICATE|FOREIGN/);
  });

  it("keeps repeated quota retries non-terminal until ZCode reports an actual failed turn", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => {
      for (const nextAttempt of [2, 3]) rpc.emit("session.updated", {
        type: "model_retry_scheduled", nextAttempt, maxAttempts: 11, message: "Native five-hour quota exhausted", statusCode: 429,
      });
      rpc.emit("turn.failed", { error: { code: "NATIVE_MODEL_LIMIT", message: "Native five-hour quota exhausted" } });
    };
    const events = await collect(client.run("sess_native", "request"));
    expect(events.map(event => event.type)).toEqual(["runtime_progress", "runtime_progress", "error"]);
    expect(events.at(-1)).toEqual({ type: "error", code: "NATIVE_MODEL_LIMIT", message: "Native five-hour quota exhausted" });
    expect(rpc.calls.some(call => call.method === "session/stop")).toBe(false);
  });

  it("preserves advertised reasoning levels and their native default through history reads", async () => {
    const rpc = new ZCodeFixture();
    rpc.models[0].reasoning = { levels: [{ value: "low" }, { value: "high" }, { value: "max" }, { value: "high" }, { value: "unknown" }], defaultLevel: "max" };
    const client = new ZCodeClient(rpc);
    await client.read("sess_native");
    expect(await client.listModels()).toMatchObject([{ reasoningEfforts: ["low", "high", "max"] }]);
    await collect(client.run("sess_native", "request", undefined, { model: { providerID: "zcode-native", id: "native-model" } }));
    expect(rpc.calls.find(call => call.method === "session/send")?.params).toMatchObject({ modelSelection: {
      providerId: "zcode-native", modelId: "native-model", options: { reasoningLevel: "max" },
    } });
  });

  it("keeps an explicit effort instead of the native model default", async () => {
    const rpc = new ZCodeFixture();
    rpc.models[0].reasoning = { levels: [{ value: "low" }, { value: "max" }], defaultLevel: "max" };
    const client = new ZCodeClient(rpc);
    await collect(client.run("sess_native", "request", undefined, { model: { providerID: "zcode-native", id: "native-model" }, reasoningEffort: "low" }));
    expect(rpc.calls.find(call => call.method === "session/send")?.params).toMatchObject({ modelSelection: { options: { reasoningLevel: "low" } } });
  });

  it.each(["unknown", "max"])("does not invent an unadvertised native default %s", defaultLevel => {
    const rpc = new ZCodeFixture();
    rpc.models[0].reasoning = { levels: [{ value: "high" }], defaultLevel };
    const client = new ZCodeClient(rpc);
    return collect(client.run("sess_native", "request", undefined, { model: { providerID: "zcode-native", id: "native-model" } })).then(() => {
      expect(rpc.calls.find(call => call.method === "session/send")?.params.modelSelection).toEqual({ providerId: "zcode-native", modelId: "native-model" });
    });
  });

  it("scopes model defaults to the native provider as well as the model id", async () => {
    const rpc = new ZCodeFixture();
    rpc.models[0].reasoning = { levels: [{ value: "max" }], defaultLevel: "max" };
    rpc.models.push({ ref: { providerId: "other-native", modelId: "native-model" }, reasoning: { levels: [{ value: "low" }], defaultLevel: "low" } });
    const client = new ZCodeClient(rpc);
    await collect(client.run("sess_native", "request", undefined, { model: { providerID: "other-native", id: "native-model" } }));
    expect(rpc.calls.find(call => call.method === "session/send")?.params).toMatchObject({ modelSelection: { providerId: "other-native", options: { reasoningLevel: "low" } } });
  });

  it("does not resume a foreign active writer to discover native models", async () => {
    const rpc = new ZCodeFixture(); rpc.session.status = "running"; rpc.models = [];
    const client = new ZCodeClient(rpc);
    expect(await client.listModels()).toEqual([]);
    expect(rpc.calls.some(call => call.method === "session/resume")).toBe(false);
  });

  it("preserves actual native configuration failures instead of reporting acceptance as success", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => rpc.emit("turn.failed", { error: { code: "CONFIGURATION_ERROR", message: "Select a model before continuing" } });
    expect(await collect(client.run("sess_native", "request"))).toEqual([{ type: "error", code: "CONFIGURATION_ERROR", message: "Select a model before continuing" }]);
  });

  it("waits for explicit permission selection and returns the native decision payload", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    let decision: unknown;
    rpc.prompt = async () => {
      decision = await rpc.handler("interaction/requestPermission", { sessionId: "sess_native", toolName: "Write", reason: "Edit file", options: [{ optionId: "allow", name: "Allow once", response: { decision: "allow" } }, { optionId: "deny", name: "Deny", response: { decision: "deny", reason: "Rejected" } }] });
      rpc.emit("turn.completed", {});
    };
    const iterator = client.run("sess_native", "permission")[Symbol.asyncIterator]();
    const next = await iterator.next(); if (next.value.type !== "ask_user") throw new Error("Expected approval");
    expect(decision).toBeUndefined();
    await expect(client.answerQuestion(next.value.questionId, { answer: "unknown" })).rejects.toMatchObject({ code: "QUESTION_ANSWER_FAILED" });
    await client.answerQuestion(next.value.questionId, { answer: "Deny", selectedIndices: [1] });
    while (!(await iterator.next()).done) {}
    expect(decision).toEqual({ decision: "deny", reason: "Rejected" });
    expect(await rpc.handler("interaction/requestPermission", { sessionId: "sess_native" })).toMatchObject({ decision: "deny" });
  });

  it("maps native user questions without enabling native automatic resolution", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    let answer: unknown;
    rpc.prompt = async () => {
      answer = await rpc.handler("interaction/requestUserInput", { sessionId: "sess_native", questions: [{ question: "Choose branch", options: [{ value: "main", label: "Main" }, { value: "feature", label: "Feature" }] }] });
      rpc.emit("turn.completed", {});
    };
    const iterator = client.run("sess_native", "question")[Symbol.asyncIterator]();
    const next = await iterator.next(); if (next.value.type !== "ask_user") throw new Error("Expected question");
    await client.answerQuestion(next.value.questionId, { answer: "Feature", selectedIndices: [1] });
    while (!(await iterator.next()).done) {}
    expect(answer).toEqual({ action: "accept", content: { answers: { "Choose branch": "feature" } } });
    await expect(rpc.handler("interaction/unsupportedOperation", {})).rejects.toThrow("Unsupported");
  });

  it("declines native account-header requests with the ZCode protocol result, without echoing credentials", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    const result = await rpc.handler("interaction/requestProviderRuntimeHeaders", {
      sessionId: "sess_native", requestId: "native-account-request", privateContext: "must-not-be-reflected",
    });
    expect(result).toEqual({
      headersApplied: false,
      errorMessage: "ZCode requires its native host account bridge for model credentials; AgentRoam does not substitute CA model credentials.",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-reflected");
    expect(rpc.calls).toEqual([]);
    await client.dispose();
  });

  it("keeps a missing native account bridge a failed turn, not an approval or successful response", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => {
      const result = await rpc.handler("interaction/requestProviderRuntimeHeaders", { sessionId: "sess_native" }) as { headersApplied: boolean; errorMessage: string };
      rpc.emit("turn.failed", { error: { code: "MODEL_CREDENTIALS_UNAVAILABLE", message: result.errorMessage } });
    };
    expect(await collect(client.run("sess_native", "request"))).toEqual([{
      type: "error", code: "MODEL_CREDENTIALS_UNAVAILABLE",
      message: "ZCode requires its native host account bridge for model credentials; AgentRoam does not substitute CA model credentials.",
    }]);
  });

  it("stops the native session and emits abort rather than done", async () => {
    const rpc = new ZCodeFixture(); const client = new ZCodeClient(rpc);
    rpc.prompt = async () => rpc.emit("model.streaming", { kind: "text_delta", delta: "partial" });
    const iterator = client.run("sess_native", "long turn")[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe("text_chunk"); await client.abort("sess_native");
    expect((await iterator.next()).value).toEqual({ type: "turn_aborted" });
    expect((await iterator.next()).done).toBe(true);
    expect(rpc.calls.at(-1)).toMatchObject({ method: "session/stop", params: { sessionId: "sess_native" } });
  });

  it("reads native message/tool/reasoning parts and rejects unsupported images explicitly", async () => {
    const messages = decodeZCodeHistory([{ info: { id: "message", role: "assistant" }, parts: [{ type: "text", text: "text" }, { id: "reason", type: "reasoning", text: "thought" }, { type: "tool", callID: "call", tool: "Read", state: { input: { path: "README" }, status: "completed", output: "native result" } }] }]);
    expect(messages[0]).toMatchObject({ role: "assistant", content: "text", presentation: { reasoning: [{ text: "thought" }] }, toolCalls: [{ id: "call", name: "Read" }] });
    expect(messages[1]).toMatchObject({ role: "tool", content: "native result", toolCallId: "call" });
    const client = new ZCodeClient(new ZCodeFixture());
    await expect(collect(client.run("sess_native", "image", ["data:image/png;base64,AAAA"]))).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
  });
});
