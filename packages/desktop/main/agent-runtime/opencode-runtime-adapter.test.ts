import { describe, expect, it, vi } from "vitest";
import type { Event, OpencodeClient, Session } from "@opencode-ai/sdk";
import {
  OpenCodeRuntimeAdapter,
  openCodeHistoryToMessages,
  openCodeSessionToSummary,
  resolveOpenCodeDataRoot,
  type OpenCodeServerPort,
} from "./opencode-runtime-adapter.js";

const session: Session = {
  id: "ses_1",
  projectID: "project-1",
  directory: "/repo",
  title: "OpenCode work",
  version: "1.18.27",
  time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
};

function mockServer() {
  let listener: ((event: { directory: string; payload: Event }) => void) | undefined;
  const client = {
    project: { list: vi.fn(async () => ({ data: [{ id: "project-1", worktree: "/repo", time: { created: 1 } }] })) },
    session: {
      list: vi.fn(async () => ({ data: [session] })),
      status: vi.fn(async () => ({ data: {} })),
      get: vi.fn(async () => ({ data: session })),
      messages: vi.fn(async () => ({ data: [] })),
      create: vi.fn(async () => ({ data: session })),
      fork: vi.fn(async () => ({ data: { ...session, id: "ses_fork", parentID: session.id } })),
      promptAsync: vi.fn(async () => ({ data: undefined })),
      abort: vi.fn(async () => ({ data: true })),
    },
    postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
  };
  const server: OpenCodeServerPort = {
    client: async () => client as unknown as OpencodeClient,
    subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
    dispose: vi.fn(async () => undefined),
  };
  return {
    client,
    server,
    emit(payload: Event) { listener?.({ directory: "/repo", payload }); },
  };
}

async function drain(iterable: AsyncIterable<unknown>) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe("OpenCode runtime mapping", () => {
  it("uses OpenCode's XDG data directory for external history observation", () => {
    expect(resolveOpenCodeDataRoot({ XDG_DATA_HOME: "/var/data" })).toBe("/var/data/opencode");
  });
  it("marks externally busy sessions as read-only and keeps model identity in the source", () => {
    const summary = openCodeSessionToSummary(
      { ...session, agent: "build", model: { providerID: "openai", id: "gpt-5" } } as Session,
      { type: "busy" },
    );
    expect(summary).toMatchObject({
      id: "runtime:opencode:c2VzXzE",
      occupancy: "owned-externally",
      canResume: false,
      sourceLabel: "OpenCode · build · openai/gpt-5",
    });
  });

  it("maps text, images, reasoning, and completed tools from history", () => {
    const messages = openCodeHistoryToMessages([{
      info: {
        id: "msg_1", sessionID: session.id, role: "assistant", parentID: "user_1",
        modelID: "gpt-5", providerID: "openai", mode: "build", path: { cwd: "/repo", root: "/repo" },
        time: { created: 1 }, cost: 0, tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
      },
      parts: [
        { id: "text", sessionID: session.id, messageID: "msg_1", type: "text", text: "done" },
        { id: "reason", sessionID: session.id, messageID: "msg_1", type: "reasoning", text: "thinking", time: { start: 1 } },
        { id: "image", sessionID: session.id, messageID: "msg_1", type: "file", mime: "image/png", filename: "x.png", url: "data:image/png;base64,AAAA" },
        { id: "tool", sessionID: session.id, messageID: "msg_1", type: "tool", callID: "call_1", tool: "read", state: { status: "completed", input: { filePath: "a" }, output: "ok", title: "read", metadata: {}, time: { start: 1, end: 2 } } },
      ],
    }]);
    expect(messages[0]).toMatchObject({ role: "assistant", content: "done", images: ["data:image/png;base64,AAAA"] });
    expect(messages[0].presentation?.reasoning?.[0].text).toBe("thinking");
    expect(messages[0].toolCalls?.[0]).toMatchObject({ id: "call_1", name: "read" });
    expect(messages[1]).toEqual({ role: "tool", toolCallId: "call_1", content: "ok" });
  });
});

describe("OpenCodeRuntimeAdapter", () => {
  it("discovers, creates, and forks through the project-scoped API", async () => {
    const fixture = mockServer();
    const adapter = new OpenCodeRuntimeAdapter({ server: fixture.server });
    await expect(adapter.discoverSessions()).resolves.toEqual([
      expect.objectContaining({ nativeSessionId: "ses_1", agentType: "opencode" }),
    ]);
    await expect(adapter.create({ title: "x", cwd: "/repo" })).resolves.toMatchObject({ nativeSessionId: "ses_1" });
    await expect(adapter.fork("ses_1")).resolves.toMatchObject({ nativeSessionId: "ses_fork", parentSessionId: "runtime:opencode:c2VzXzE" });
    await expect(adapter.getSessionWatchPath("ses_1")).resolves.toMatch(/opencode\.db(?:-wal)?$/);
  });

  it("queries imported workspace sessions with the imported directory", async () => {
    const fixture = mockServer();
    const adapter = new OpenCodeRuntimeAdapter({ server: fixture.server });

    await adapter.listWorkspaceSessionsByPath("/manual/repo");

    expect(fixture.client.session.list).toHaveBeenCalledWith({
      query: { directory: "/manual/repo" },
      throwOnError: true,
    });
    expect(fixture.client.session.status).toHaveBeenCalledWith({
      query: { directory: "/manual/repo" },
      throwOnError: true,
    });
  });

  it("streams assistant deltas once and terminates on idle", async () => {
    const fixture = mockServer();
    const adapter = new OpenCodeRuntimeAdapter({ server: fixture.server });
    const result = drain(adapter.run("ses_1", "hello"));
    await vi.waitFor(() => expect(fixture.client.session.promptAsync).toHaveBeenCalled());
    expect(fixture.client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ messageID: expect.stringMatching(/^msg_/) }),
    }));
    fixture.emit({ type: "message.updated", properties: { info: {
      id: "assistant_1", sessionID: "ses_1", role: "assistant", parentID: "user_1",
      modelID: "gpt-5", providerID: "openai", mode: "build", path: { cwd: "/repo", root: "/repo" },
      time: { created: 1 }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    } } });
    fixture.emit({ type: "message.part.updated", properties: {
      part: { id: "part_1", sessionID: "ses_1", messageID: "assistant_1", type: "text", text: "hello" }, delta: "hello",
    } });
    fixture.emit({ type: "message.part.updated", properties: {
      part: { id: "part_1", sessionID: "ses_1", messageID: "assistant_1", type: "text", text: "hello world" }, delta: " world",
    } });
    fixture.emit({ type: "session.idle", properties: { sessionID: "ses_1" } });
    await expect(result).resolves.toEqual([
      { type: "text_chunk", text: "hello" },
      { type: "text_chunk", text: " world" },
      { type: "text_done" },
      { type: "done", finalText: "hello world" },
    ]);
  });

  it("ignores malformed message events without losing a later idle event", async () => {
    const fixture = mockServer();
    const adapter = new OpenCodeRuntimeAdapter({ server: fixture.server });
    const result = drain(adapter.run("ses_1", "hello"));
    await vi.waitFor(() => expect(fixture.client.session.promptAsync).toHaveBeenCalled());

    expect(() => fixture.emit({
      type: "message.updated",
      properties: {},
    } as unknown as Event)).not.toThrow();
    expect(() => fixture.emit({
      type: "message.part.updated",
      properties: {},
    } as unknown as Event)).not.toThrow();
    fixture.emit({ type: "session.idle", properties: { sessionID: "ses_1" } });

    await expect(result).resolves.toEqual([
      { type: "text_done" },
      { type: "done", finalText: "" },
    ]);
  });

  it("auto-approves safe requests but surfaces request-approval operations", async () => {
    const fixture = mockServer();
    const adapter = new OpenCodeRuntimeAdapter({ server: fixture.server });
    const result = drain(adapter.run("ses_1", "hello", undefined, undefined, undefined, { permissionMode: "request-approval", brokerRunId: "run_1" }));
    await vi.waitFor(() => expect(fixture.client.session.promptAsync).toHaveBeenCalled());
    fixture.emit({ type: "permission.updated", properties: {
      id: "perm_1", type: "bash", pattern: "git status", sessionID: "ses_1", messageID: "msg_1", title: "Run git status", metadata: {}, time: { created: 1 },
    } });
    await vi.waitFor(async () => {
      const pending = await adapter.answerQuestion("native:run_1:perm_1", { answer: "允许一次" });
      expect(pending).toBe(true);
    });
    fixture.emit({ type: "session.idle", properties: { sessionID: "ses_1" } });
    const events = await result;
    expect(events).toContainEqual(expect.objectContaining({ type: "ask_user", questionId: "native:run_1:perm_1" }));
    expect(fixture.client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith(expect.objectContaining({ body: { response: "once" } }));
  });

  it("aborts the native session and closes the active stream", async () => {
    const fixture = mockServer();
    const adapter = new OpenCodeRuntimeAdapter({ server: fixture.server });
    const result = drain(adapter.run("ses_1", "hello"));
    await vi.waitFor(() => expect(fixture.client.session.promptAsync).toHaveBeenCalled());
    await adapter.abort("ses_1");
    await expect(result).resolves.toContainEqual({ type: "turn_aborted" });
  });
});

describe("OpenCode model selection", () => {
  it("sends the provider-scoped model with the prompt when provided", async () => {
    const fixture = mockServer();
    const adapter = new OpenCodeRuntimeAdapter({ server: fixture.server });
    const result = drain(adapter.run("ses_1", "hello", undefined, undefined, undefined, {
      model: { id: "gpt-5.6-sol", providerID: "openai" },
    }));
    await vi.waitFor(() => expect(fixture.client.session.promptAsync).toHaveBeenCalled());
    expect(fixture.client.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ model: { providerID: "openai", modelID: "gpt-5.6-sol" } }),
    }));
    fixture.emit({ type: "session.idle", properties: { sessionID: "ses_1" } });
    await result;
  });

  it("omits the model field when the run carries none", async () => {
    const fixture = mockServer();
    const adapter = new OpenCodeRuntimeAdapter({ server: fixture.server });
    const result = drain(adapter.run("ses_1", "hello"));
    await vi.waitFor(() => expect(fixture.client.session.promptAsync).toHaveBeenCalled());
    const call = (vi.mocked(fixture.client.session.promptAsync).mock.calls as unknown as Array<[{ body: Record<string, unknown> }]>)[0]?.[0];
    expect(call.body.model).toBeUndefined();
    fixture.emit({ type: "session.idle", properties: { sessionID: "ses_1" } });
    await result;
  });

  it("flattens provider catalogs into provider-scoped picker models", async () => {
    const fixture = mockServer();
    (fixture.client as Record<string, unknown>).config = {
      providers: vi.fn(async () => ({ data: {
        providers: [
          { id: "openai", name: "OpenAI", models: { "gpt-5.6-sol": { name: "GPT-5.6-Sol" }, "gpt-5-mini": {} } },
          { id: "anthropic", name: "Anthropic", models: { "claude-opus-4-6": { name: "Claude Opus 4.6" } } },
        ],
      } })),
    };
    const adapter = new OpenCodeRuntimeAdapter({ server: fixture.server });
    const models = await adapter.listModels();
    expect(models).toEqual([
      { id: "gpt-5.6-sol", providerID: "openai", displayName: "GPT-5.6-Sol" },
      { id: "gpt-5-mini", providerID: "openai", displayName: "openai/gpt-5-mini" },
      { id: "claude-opus-4-6", providerID: "anthropic", displayName: "Claude Opus 4.6" },
    ]);
  });
});
