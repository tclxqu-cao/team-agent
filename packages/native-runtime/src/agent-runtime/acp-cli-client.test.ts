import { restoreAcpQuestionHistory } from "./acp-session-projection.js";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@agent/core";
import { AcpCliClient } from "./acp-cli-client.js";
import { AcpCliRuntimeAdapter } from "./acp-cli-runtime-adapter.js";
import { UnifiedSessionService } from "./unified-session-service.js";
import type { NativeRpcConnection } from "./native-rpc-client.js";
import type { NativeJsonPacket } from "./native-stdio-channel.js";

const directory = "/project";
const sessionId = "native-1";
const updatedAt = "2026-11-23T00:00:00Z";

function fixture(embeddedContext = true) {
  const listeners = new Set<(method: string, params: NativeJsonPacket) => void>();
  let callback!: Parameters<NativeRpcConnection["onRequest"]>[0];
  const update = (target: string, data: NativeJsonPacket) => {
    for (const listener of listeners) listener("session/update", { sessionId: target, update: data });
  };
  const chunk = (target: string, role: string, text: string) =>
    update(target, { sessionUpdate: role + "_message_chunk", content: { type: "text", text } });
  const configOptions = [{
    id: "engine", category: "model", currentValue: "model-a",
    options: [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }],
  }];
  const request = vi.fn<NativeRpcConnection["request"]>(async (method, params) => {
    switch (method) {
      case "initialize":
        return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} },
          promptCapabilities: { embeddedContext } } };
      case "session/list":
        return params.cursor
          ? { sessions: [{ sessionId, cwd: directory, updatedAt, title: "Native session" }] }
          : { sessions: [], nextCursor: "next-page" };
      case "session/load":
        chunk(sessionId, "user", "previous question");
        chunk(sessionId, "agent", "previous answer");
        return { configOptions };
      case "session/new":
        return { sessionId, configOptions };
      case "session/set_config_option":
        return { configOptions: [{ ...configOptions[0], currentValue: params.value }] };
      case "session/prompt":
        chunk("unrelated", "agent", "ignore");
        chunk(sessionId, "agent", "stream");
        chunk(sessionId, "agent", "ed");
        return { stopReason: "end_turn" };
      default:
        throw new Error(method);
    }
  });
  const notify = vi.fn<NativeRpcConnection["notify"]>(async () => {});
  const rpc: NativeRpcConnection = {
    request, notify,
    onRequest(handler) { callback = handler; },
    onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onFailure: () => () => {},
    async dispose() {},
  };
  return { rpc, request, notify, update, callback: (method: string, params: NativeJsonPacket) => callback(method, params) };
}

describe("ACP CLI sessions", () => {
  it("uses negotiated capabilities for health and attachment admission", async () => {
    const { rpc } = fixture(false);
    const runtime = new UnifiedSessionService([
      new AcpCliRuntimeAdapter("grok", new AcpCliClient("grok", rpc)),
    ], async () => []);
    try {
      await expect(runtime.health()).resolves.toMatchObject([{
        agentType: "grok", available: true, capabilities: { promptFileAttachments: false },
      }]);
      await expect(runtime.assertPromptFileAttachments("grok")).rejects.toMatchObject({
        code: "OPERATION_NOT_SUPPORTED",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("requires catalog access before advertising availability and can recover after login", async () => {
    const { rpc, request } = fixture();
    const client = new AcpCliClient("agy", rpc);
    const initialize = request.getMockImplementation()!;
    request.mockImplementation((method, params) => method === "session/list"
      ? Promise.reject(new Error("Authentication required")) : initialize(method, params));
    try {
      await expect(client.available()).rejects.toThrow("Authentication required");
      request.mockImplementation(initialize);
      await expect(client.getCapabilities()).resolves.toEqual({ promptFileAttachments: true, nativePermissionPresets: true });
    } finally { await client.dispose(); }
  });

  it("opens and closes one temporary Antigravity session for concurrent cold model requests", async () => {
    const { rpc, request } = fixture();
    const client = new AcpCliClient("agy", rpc);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method === "initialize") {
        return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} } } };
      }
      if (method === "session/close") return {};
      return original(method, params);
    });
    try {
      const [first, second] = await Promise.all([client.listModels(), client.listModels()]);
      expect(first.map(model => model.id)).toEqual(["model-a", "model-b"]);
      expect(second).toEqual(first);
      expect(await client.listModels()).toEqual(first);
      expect(request.mock.calls.map(([method]) => method)).toEqual(["initialize", "session/new", "session/close"]);
      expect(request).toHaveBeenCalledWith("session/close", { sessionId }, expect.any(Number));
      expect(await client.list()).toMatchObject([{ id: sessionId, cwd: directory }]);
    } finally { await client.dispose(); }
  });

  it("keeps Grok's selectable modes when the native notification contains only the current mode", async () => {
    const { rpc, request, update } = fixture();
    const client = new AcpCliClient("grok", rpc);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method, params) => {
      if (method === "session/load") update(sessionId, { sessionUpdate: "current_mode_update", currentModeId: "plan" });
      if (method === "session/set_mode") return {};
      return original(method, params);
    });
    try {
      expect((await client.read(sessionId)).session.nativePermissions).toMatchObject({
        currentValue: "plan", options: [{ value: "default" }, { value: "plan" }],
      });
      await client.setMode(sessionId, "default");
      expect(request).toHaveBeenCalledWith("session/set_mode", { sessionId, modeId: "default" });
      expect((await client.read(sessionId)).session.nativePermissions).toMatchObject({ currentValue: "default" });
    } finally { await client.dispose(); }
  });

  it("sends an explicit Grok default selection when the CLI did not report a current mode", async () => {
    const { rpc, request } = fixture();
    const client = new AcpCliClient("grok", rpc);
    const original = request.getMockImplementation()!;
    request.mockImplementation((method, params) => method === "session/set_mode"
      ? Promise.resolve({}) : original(method, params));
    try {
      await client.setMode(sessionId, "default");
      expect(request).toHaveBeenCalledWith("session/set_mode", { sessionId, modeId: "default" });
    } finally { await client.dispose(); }
  });

  it.each(["grok", "agy"] as const)("loads and continues %s by native ID without duplicating replay", async agent => {
    const { rpc, request } = fixture();
    const client = new AcpCliClient(agent, rpc);
    try {
      const detail = await client.read(sessionId);
      expect(detail.messages.map(message => message.content)).toEqual(["previous question", "previous answer"]);
      const events: AgentEvent[] = [];
      for await (const event of client.run(sessionId, "follow-up", undefined, { model: { id: "model-b" } })) events.push(event);
      expect(events).toEqual([
        { type: "text_chunk", text: "stream" }, { type: "text_chunk", text: "ed" },
        { type: "done", finalText: "streamed" },
      ]);
      expect(request).toHaveBeenCalledWith("session/set_config_option", { sessionId, configId: "engine", value: "model-b" });
      expect(request.mock.calls.filter(([method]) => method === "session/load")).toHaveLength(1);
      expect((await client.read(sessionId)).messages.map(message => message.content))
        .toEqual(["previous question", "previous answer", "follow-up", "streamed"]);
    } finally { await client.dispose(); }
  });

  it("cancels a pending approval and waits for the native cancel result", async () => {
    const { rpc, request, notify, callback } = fixture();
    const client = new AcpCliClient("agy", rpc);
    let confirmCancel!: (result: NativeJsonPacket) => void;
    const cancelled = new Promise<NativeJsonPacket>(resolve => { confirmCancel = resolve; });
    const params = { sessionId, toolCall: { title: "Read file" }, options: [{ optionId: "allow", name: "Allow" }] };
    const initialize = request.getMockImplementation()!;
    request.mockImplementation(async (method, data) => {
      if (method !== "session/prompt") return initialize(method, data);
      await expect(callback("session/request_permission", params)).resolves.toEqual({ outcome: { outcome: "cancelled" } });
      return cancelled;
    });
    try {
      await client.create({ title: "Draft", cwd: directory });
      const run = client.run(sessionId, "first turn")[Symbol.asyncIterator]();
      expect((await run.next()).value).toMatchObject({ type: "ask_user", question: "Read file" });
      // Until the RPC terminates, the broker owns the turn and supplies the live overlay.
      expect((await client.read(sessionId)).messages).toEqual([]);
      await client.abort(sessionId);
      expect(notify).toHaveBeenCalledWith("session/cancel", { sessionId });
      expect((await run.next()).value).toMatchObject({ type: "approval_resolved" });
      confirmCancel({ stopReason: "cancelled" });
      expect((await run.next()).value).toEqual({ type: "turn_aborted" });
      expect((await run.next()).done).toBe(true);
    } finally { await client.dispose(); }
  });

  it("does not project a native prompt failure as a successful turn", async () => {
    const { rpc, request } = fixture();
    const client = new AcpCliClient("agy", rpc);
    const initialize = request.getMockImplementation()!;
    request.mockImplementation((method, params) => method === "session/prompt"
      ? Promise.reject(new Error("Authentication required")) : initialize(method, params));
    try {
      await client.create({ title: "Draft", cwd: directory });
      const events: AgentEvent[] = [];
      for await (const event of client.run(sessionId, "test")) events.push(event);
      expect(events).toEqual([{ type: "error", message: "Authentication required" }]);
    } finally { await client.dispose(); }
  });

  it.each([
    {
      agent: "grok" as const, method: "_x.ai/ask_user_question",
      params: { questions: [{ question: "Pick a color", options: [{ label: "Red" }, { label: "Blue" }] }] },
      expected: { outcome: "accepted", answers: { "Pick a color": ["Blue"] } },
    },
    {
      agent: "agy" as const, method: "elicitation/create",
      params: { mode: "form", message: "Pick a color", requestedSchema: { type: "object", properties: {
        q1: { type: "string", oneOf: [{ const: "1", title: "Red" }, { const: "2", title: "Blue" }] },
        q1_other: { type: "string", title: "Other" },
      } } },
      expected: { action: "accept", content: { q1: "2" } },
    },
  ])("answers the $agent native card without a second optional card", async ({ agent, method, params, expected }) => {
    const { rpc, request, callback } = fixture();
    const client = new AcpCliClient(agent, rpc);
    const original = request.getMockImplementation()!;
    const answers: unknown[] = [];
    request.mockImplementation(async (name, data) => {
      if (name !== "session/prompt") return original(name, data);
      answers.push(await callback(method, { sessionId, ...params }));
      return { stopReason: "end_turn" };
    });
    try {
      await client.create({ title: "Draft", cwd: directory });
      const run = client.run(sessionId, "Ask me")[Symbol.asyncIterator]();
      const first = (await run.next()).value as Extract<AgentEvent, { type: "ask_user" }>;
      expect(first).toMatchObject({ type: "ask_user", cancellable: true });
      expect(await client.answerQuestion(first.questionId, { answer: "Blue", selectedIndices: [1] })).toBe(true);
      expect((await run.next()).value).toMatchObject({ type: "approval_resolved", userTurnIndex: 0 });
      expect((await run.next()).value).toMatchObject({ type: "done" });
      expect((await run.next()).done).toBe(true);
      expect(answers).toEqual([expected]);
      expect((await client.read(sessionId)).messages.at(-1)?.presentation?.question).toMatchObject({ status: "answered", answer: "Blue" });
    } finally { await client.dispose(); }
  });

  it("sends files as ACP resources with their original media type and bytes", async () => {
    const { rpc, request } = fixture();
    const client = new AcpCliClient("grok", rpc);
    try {
      await client.create({ title: "Draft", cwd: directory });
      for await (const _event of client.run(sessionId, "Files", undefined, { attachments: [
        { name: "notes.csv", mimeType: "text/csv", data: Buffer.from("word,value").toString("base64") },
        { name: "paper.pdf", mimeType: "application/pdf", data: "AP8=" },
      ] })) { /* consume the turn */ }
      expect(request).toHaveBeenCalledWith("session/prompt", { sessionId, prompt: [
        { type: "text", text: "Files" },
        { type: "resource", resource: { uri: "file:///agentroam-attachments/1/notes.csv", mimeType: "text/csv", text: "word,value" } },
        { type: "resource", resource: { uri: "file:///agentroam-attachments/2/paper.pdf", mimeType: "application/pdf", blob: "AP8=" } },
      ] }, expect.any(Number));
    } finally { await client.dispose(); }
  });
});

it("places answers on the correct turn when consecutive prompts have identical text", () => {
  const messages = [
    { role: "user", content: "Same prompt" },
    { role: "assistant", content: "First reply" },
    { role: "user", content: "Same prompt" },
    { role: "assistant", content: "Second reply" },
  ] satisfies import("@agent/core").Message[];
  const questions = ["First answer", "Second answer"].map((answer, userTurnIndex) => {
    const questionId = `question-${userTurnIndex}`;
    return {
      input: "Same prompt",
      event: {
        type: "approval_resolved" as const, questionId, userTurnIndex,
        resolvedQuestion: { questionId, question: "Choose", options: [], multiSelect: false, status: "answered" as const, answer },
      },
    };
  });
  const restored = restoreAcpQuestionHistory(messages, questions);
  expect(restored.map(message => message.presentation?.question?.answer ?? message.content)).toEqual([
    "Same prompt", "First answer", "First reply", "Same prompt", "Second answer", "Second reply",
  ]);
  expect(restoreAcpQuestionHistory(restored, questions)).toEqual(restored);
});
