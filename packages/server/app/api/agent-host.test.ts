import { AgentBuilder, type IModelProvider, type Message, type StreamEvent, type StreamOptions } from "@agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep these route tests independent of real Codex/Claude discovery on disk.
vi.mock("../../lib/native-runtime-service", () => ({
  getNativeRuntimeService: () => ({
    health: async () => [],
    list: async () => [],
    refresh: async () => [],
    create: async () => { throw new Error("not available in tests"); },
    get: async () => { throw new Error("not available in tests"); },
    run: async function* () { throw new Error("not available in tests"); },
    answerQuestion: async () => false,
    abort: async () => {},
  }),
  isNativeSessionId: () => false,
  runtimeErrorStatus: () => 500,
}));

import { agentHost } from "./agent-host";
import { POST as runAgent } from "./agent/run/route";
import { POST as registerRemoteTools } from "./remote-tools/register/route";
import { GET as listSessions, POST as createSession } from "./sessions/route";
import { GET as getSession, PATCH as updateSession } from "./sessions/[id]/route";

class CapturingModelProvider implements IModelProvider {
  readonly providerId = "test";
  readonly modelId = "test-model";
  messages: Message[] = [];
  options: StreamOptions | undefined;
  eventBatches: StreamEvent[][] = [[{ type: "text_done" }]];

  async *streamChat(messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent> {
    this.messages = messages;
    this.options = options;
    yield* (this.eventBatches.shift() ?? []);
  }

  async countTokens(): Promise<number> { return 1; }
  supportsModel(): boolean { return true; }
}

class BlockingTool {
  readonly name = "blocking_lookup";
  readonly description = "Wait until the test releases the tool";
  readonly parameters = { type: "object", properties: {} };
  readonly schema = {
    safeParse: (value: unknown) => ({ success: true as const, data: value }),
  } as never;
  readonly started: Promise<void>;
  private signalStarted!: () => void;
  private releaseTool!: () => void;
  private readonly released: Promise<void>;

  constructor() {
    this.started = new Promise((resolve) => { this.signalStarted = resolve; });
    this.released = new Promise((resolve) => { this.releaseTool = resolve; });
  }

  release(): void {
    this.releaseTool();
  }

  async execute() {
    this.signalStarted();
    await this.released;
    return { toolCallId: "", content: "lookup result" };
  }
}

const kidEarthTool = {
  scheme: "create_kid_earth_course",
  purpose: "创建课程",
  url: "http://kid/api/agent-actions/create-course",
  method: "POST" as const,
};

const projectBTool = {
  scheme: "create_project_b_course",
  purpose: "项目 B 创建课程",
  url: "http://project-b/api/agent-actions/create-course",
  method: "POST" as const,
};

describe("agentHost singleton", () => {
  const originalEnv = { ...process.env };

  afterEach(async () => {
    process.env = { ...originalEnv };
    await agentHost.getProjectStore().delete("agent-host-cwd-test");
  });

  it("stores the shared AgentHost on globalThis so answer routes can see pending questions from run routes", () => {
    expect((globalThis as unknown as { __agentHost?: unknown }).__agentHost).toBe(agentHost);
  });

  it("registers remote tools through the server route and exposes them through the runtime builder", async () => {
    process.env.AGENT_REMOTE_TOOLS_REGISTER_TOKEN = "test-token";
    const provider = new CapturingModelProvider();
    agentHost.setBuilder(new AgentBuilder().withModelProvider(provider));

    const response = await registerRemoteTools(new Request("http://test/api/remote-tools/register", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ projectId: "kid-earth-learning", tools: [kidEarthTool] }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, tools: [{ scheme: "create_kid_earth_course" }] });

    const session = await agentHost.createSession("remote tools runtime test", "kid-earth-learning");
    const agent = await agentHost.getBuilder().withRemoteToolStore(agentHost.getRemoteToolStore(), "kid-earth-learning").build();
    for await (const event of agent.run("生成课程", session.id)) {
      if (event.type === "done") break;
    }

    const remoteToolDefinition = provider.options?.tools?.find((tool) => tool.name === "remote_project_action");
    expect(remoteToolDefinition?.description).toContain("create_kid_earth_course");
    expect(provider.messages.find((message) => message.role === "system")?.content).toContain("create_kid_earth_course");
  });

  it("stores projectId from the sessions API", async () => {
    const response = await createSession(new Request("http://test/api/sessions", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ title: "课程创建", projectId: "kid-earth-learning" }),
    }));

    expect(response.status).toBe(201);
    const session = await response.json();
    expect(session).toMatchObject({ title: "课程创建", projectId: "kid-earth-learning" });
    await expect(agentHost.getSessionStore().get(session.id)).resolves.toMatchObject({ projectId: "kid-earth-learning" });
  });

  it("defaults permission mode to full access and persists session updates", async () => {
    const session = await agentHost.createSession("permission mode test");
    expect(session.metadata.permissionMode).toBe("full-access");

    const response = await updateSession(new Request(`http://test/api/sessions/${session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ permissionMode: "request-approval" }),
    }), { params: { id: session.id } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: session.id,
      permissionMode: "request-approval",
      metadata: { permissionMode: "request-approval" },
    });
    await expect(agentHost.getSessionStore().get(session.id)).resolves.toMatchObject({
      metadata: { permissionMode: "request-approval" },
    });
  });

  it("persists the first input as the title only for newly marked placeholder sessions", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [
      [{ type: "text_done" }],
      [{ type: "text_done" }],
      [{ type: "text_done" }],
      [{ type: "text_done" }],
    ];
    agentHost.setBuilder(new AgentBuilder()
      .withModelProvider(provider)
      .withSemanticSkillMatching(false));

    const placeholder = await agentHost.createSession("新会话");
    expect(placeholder.metadata.autoTitleFromFirstMessage).toBe(true);
    await agentHost.run("第一条消息", placeholder.id);
    await agentHost.run("后续消息", placeholder.id);
    await expect(agentHost.getSessionStore().get(placeholder.id)).resolves.toMatchObject({
      title: "第一条消息",
      metadata: { permissionMode: "full-access" },
    });

    const explicit = await agentHost.createSession("显式标题");
    await agentHost.run("不能覆盖显式标题", explicit.id);
    await expect(agentHost.getSessionStore().get(explicit.id)).resolves.toMatchObject({ title: "显式标题" });

    const now = new Date().toISOString();
    const historicalId = crypto.randomUUID();
    await agentHost.getSessionStore().create({
      id: historicalId,
      projectId: "",
      title: "新会话",
      status: "idle",
      messages: [],
      events: [],
      created: now,
      updated: now,
      metadata: { permissionMode: "full-access" },
    });
    await agentHost.run("不能回填历史会话", historicalId);
    await expect(agentHost.getSessionStore().get(historicalId)).resolves.toMatchObject({ title: "新会话" });
  }, 15_000);

  it("rejects invalid permission modes", async () => {
    const session = await agentHost.createSession("invalid permission mode test");
    const response = await updateSession(new Request(`http://test/api/sessions/${session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ permissionMode: "anything" }),
    }), { params: { id: session.id } });
    expect(response.status).toBe(400);
  });

  it("resolves a registered project path and rejects a missing project", async () => {
    const store = agentHost.getProjectStore();
    const id = "agent-host-cwd-test";
    const existing = await store.get(id);
    if (existing) await store.update(id, { description: process.cwd() });
    else {
      const now = new Date().toISOString();
      await store.create({ id, name: "cwd test", description: process.cwd(), created: now, updated: now });
    }

    await expect(agentHost.resolveProjectWorkingDirectory(id, true)).resolves.toBe(process.cwd());
    await expect(agentHost.resolveProjectWorkingDirectory("missing-project", true)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
      status: 404,
    });
  });

  it("filters session listing by projectId", async () => {
    await createSession(new Request("http://test/api/sessions", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ title: "项目 A", projectId: "project-a" }),
    }));
    await createSession(new Request("http://test/api/sessions", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ title: "项目 B", projectId: "project-b" }),
    }));

    const response = await listSessions(new Request("http://test/api/sessions?projectId=project-a", {
      headers: { authorization: "Bearer test-token" },
    }));

    expect(response.status).toBe(200);
    const sessions = await response.json();
    expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({ title: "项目 A", projectId: "project-a" })]));
    expect(sessions).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "项目 B", projectId: "project-b" })]));
  });

  it("scopes emitted events to the subscribed session", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [
      [
        { type: "tool_call", toolCall: { id: "scope-call", name: "lookup", arguments: {} } },
        { type: "text_done" },
      ],
      [
        { type: "text_chunk", text: "Only A" },
        { type: "text_done" },
      ],
    ];
    agentHost.setBuilder(new AgentBuilder().withModelProvider(provider));
    const sessionA = await agentHost.createSession("session A");
    const sessionB = await agentHost.createSession("session B");
    const eventsA: unknown[] = [];
    const eventsB: unknown[] = [];
    const subscribe = agentHost.subscribe as unknown as (
      sessionId: string,
      listener: (event: unknown) => void,
    ) => () => void;
    const unsubscribeA = subscribe.call(agentHost, sessionA.id, (event) => eventsA.push(event));
    const unsubscribeB = subscribe.call(agentHost, sessionB.id, (event) => eventsB.push(event));

    await agentHost.run("hello A", sessionA.id);
    unsubscribeA();
    unsubscribeB();

    expect(eventsA).toEqual(expect.arrayContaining([expect.objectContaining({ type: "done", finalText: "Only A" })]));
    expect(eventsB).toEqual([]);
  });

  it("persists the assistant reply before emitting done", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [
      [
        { type: "tool_call", toolCall: { id: "ordering-call", name: "lookup", arguments: {} } },
        { type: "text_done" },
      ],
      [
        { type: "text_chunk", text: "Persisted first" },
        { type: "text_done" },
      ],
    ];
    agentHost.setBuilder(new AgentBuilder().withModelProvider(provider));
    const session = await agentHost.createSession("done ordering test");
    let sessionAtDone: Promise<{ messages?: Message[] } | null> | undefined;
    let completedEvent: { type?: string; durationMs?: number } | undefined;
    const subscribe = agentHost.subscribe as unknown as (
      sessionId: string,
      listener: (event: { type?: string; durationMs?: number }) => void,
    ) => () => void;
    const unsubscribe = subscribe.call(agentHost, session.id, (event) => {
      if (event.type === "done") {
        completedEvent = event;
        sessionAtDone = agentHost.getSessionStore().get(session.id);
      }
    });

    await agentHost.run("persist before done", session.id);
    unsubscribe();

    await expect(sessionAtDone).resolves.toMatchObject({
      messages: [
        { role: "user", content: "persist before done" },
        {
          role: "assistant",
          content: "Persisted first",
          presentation: { completionDurationMs: expect.any(Number) },
        },
      ],
    });
    expect(completedEvent?.durationMs).toEqual(expect.any(Number));
  });

  it("restores the current customer-agent tool call while the tool is still running", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [
      [
        { type: "tool_call", toolCall: { id: "blocking-call", name: "blocking_lookup", arguments: {} } },
        { type: "text_done" },
      ],
      [{ type: "text_chunk", text: "Tool finished" }, { type: "text_done" }],
    ];
    const tool = new BlockingTool();
    agentHost.setBuilder(new AgentBuilder()
      .withModelProvider(provider)
      .withSemanticSkillMatching(false)
      .withTool(tool));
    const session = await agentHost.createSession("active tool recovery test");

    const running = agentHost.run("look it up", session.id);
    await tool.started;

    const response = await getSession(
      new Request(`http://test/api/sessions/${session.id}`),
      { params: { id: session.id } },
    );
    const active = await response.json();

    expect(active).toMatchObject({
      status: "active",
      activeRun: {
        eventId: expect.any(Number),
        runId: expect.any(String),
      },
      messages: [
        { role: "user", content: "look it up" },
        {
          role: "assistant",
          toolCalls: [{ id: "blocking-call", name: "blocking_lookup", arguments: {} }],
        },
      ],
    });

    tool.release();
    await running;
  });

  it("preserves chronological message order across customer-agent turns", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [
      [{ type: "text_chunk", text: "first answer" }, { type: "text_done" }],
      [{ type: "text_chunk", text: "second answer" }, { type: "text_done" }],
    ];
    agentHost.setBuilder(new AgentBuilder()
      .withModelProvider(provider)
      .withSemanticSkillMatching(false));
    const session = await agentHost.createSession("turn ordering test");

    await agentHost.run("first question", session.id);
    await agentHost.run("second question", session.id);

    const stored = await agentHost.getSessionStore().get(session.id);
    expect(stored?.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer", presentation: { completionDurationMs: expect.any(Number) } },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer", presentation: { completionDurationMs: expect.any(Number) } },
    ]);
  });

  it("commits a stale interrupted run before starting the next customer-agent turn", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [[
      { type: "text_chunk", text: "new answer" },
      { type: "text_done" },
    ]];
    agentHost.setBuilder(new AgentBuilder()
      .withModelProvider(provider)
      .withSemanticSkillMatching(false));
    const session = await agentHost.createSession("stale run recovery test");
    await agentHost.getSessionStore().addMessage(session.id, { role: "user", content: "old question" });
    await agentHost.getSessionStore().addEvent(session.id, { type: "text_chunk", text: "old partial" });
    await agentHost.getSessionStore().update(session.id, {
      status: "active",
      metadata: {
        ...session.metadata,
        customerAgentActiveRun: {
          runId: "stale-run",
          eventStart: 0,
          startedAt: "2026-09-07T00:00:00.000Z",
        },
      },
    });

    await agentHost.run("new question", session.id);

    await expect(agentHost.getSessionStore().get(session.id)).resolves.toMatchObject({
      status: "completed",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old partial" },
        { role: "user", content: "new question" },
        { role: "assistant", content: "new answer" },
      ],
    });
  });

  it("rejects a duplicate customer-agent run without disturbing the active turn", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [
      [
        { type: "tool_call", toolCall: { id: "blocking-call", name: "blocking_lookup", arguments: {} } },
        { type: "text_done" },
      ],
      [{ type: "text_chunk", text: "original answer" }, { type: "text_done" }],
    ];
    const tool = new BlockingTool();
    agentHost.setBuilder(new AgentBuilder()
      .withModelProvider(provider)
      .withSemanticSkillMatching(false)
      .withTool(tool));
    const session = await agentHost.createSession("duplicate run test");

    const running = agentHost.run("original question", session.id);
    await tool.started;
    const duplicate = await runAgent(new Request("http://test/api/agent/run", {
      method: "POST",
      body: JSON.stringify({ input: "duplicate question", sessionId: session.id }),
    }));

    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ code: "SESSION_ALREADY_RUNNING" });
    expect(agentHost.isSessionRunning(session.id)).toBe(true);

    tool.release();
    await running;
    await expect(agentHost.getSessionStore().get(session.id)).resolves.toMatchObject({
      messages: [
        { role: "user", content: "original question" },
        expect.any(Object),
        expect.any(Object),
        { role: "assistant", content: "original answer" },
      ],
    });
  });

  it("commits the recoverable tool trace when a customer-agent run is aborted", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [[
      { type: "tool_call", toolCall: { id: "aborted-call", name: "blocking_lookup", arguments: {} } },
      { type: "text_done" },
    ]];
    const tool = new BlockingTool();
    agentHost.setBuilder(new AgentBuilder()
      .withModelProvider(provider)
      .withSemanticSkillMatching(false)
      .withTool(tool));
    const session = await agentHost.createSession("aborted run history test");

    const running = agentHost.run("start then stop", session.id);
    await tool.started;
    agentHost.abort(session.id);
    await running;
    tool.release();

    await expect(agentHost.getSessionStore().get(session.id)).resolves.toMatchObject({
      status: "aborted",
      metadata: expect.not.objectContaining({ customerAgentActiveRun: expect.anything() }),
      messages: [
        { role: "user", content: "start then stop" },
        {
          role: "assistant",
          toolCalls: [{ id: "aborted-call", name: "blocking_lookup", arguments: {} }],
        },
      ],
    });
  });

  it("persists sent images as display attachments without replaying them on later turns", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [
      [{ type: "text_chunk", text: "First reply" }, { type: "text_done" }],
      [{ type: "text_chunk", text: "Second reply" }, { type: "text_done" }],
    ];
    agentHost.setBuilder(new AgentBuilder()
      .withModelProvider(provider)
      .withSemanticSkillMatching(false));
    const session = await agentHost.createSession("image history test");
    const pngDataUrl = "data:image/png;base64,iVBORw0KGgo=";

    await agentHost.run("inspect", session.id, [pngDataUrl]);

    expect(provider.messages.filter((message) => message.role === "user")).toEqual([
      expect.objectContaining({ content: "inspect", images: [pngDataUrl] }),
    ]);
    await expect(agentHost.getSessionStore().get(session.id)).resolves.toMatchObject({
      messages: [
        {
          role: "user",
          content: "inspect",
          presentation: {
            attachments: [{ type: "image", name: "image-1.png", dataUrl: pngDataUrl }],
          },
        },
        { role: "assistant", content: "First reply" },
      ],
    });

    await agentHost.run("continue", session.id);

    const historicalUserMessage = provider.messages.find((message) => message.content === "inspect");
    expect(historicalUserMessage?.images).toBeUndefined();
    const stored = await agentHost.getSessionStore().get(session.id);
    expect(stored?.messages.find((message) => message.content === "inspect")).toMatchObject({
      role: "user",
      presentation: {
        attachments: [{ type: "image", name: "image-1.png", dataUrl: pngDataUrl }],
      },
    });
  });

  it("marks failed runs without persisting a synthetic assistant reply", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [[
      { type: "error", message: "provider unavailable" },
    ]];
    agentHost.setBuilder(new AgentBuilder()
      .withModelProvider(provider)
      .withSemanticSkillMatching(false));
    const session = await agentHost.createSession("failed history test");

    await agentHost.run("This will fail", session.id);

    await expect(agentHost.getSessionStore().get(session.id)).resolves.toMatchObject({
      status: "failed",
      messages: [{ role: "user", content: "This will fail" }],
    });
  });

  it("persists partial assistant output when a customer-agent run fails", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [[
      { type: "text_chunk", text: "Partial answer" },
      { type: "error", message: "provider unavailable" },
    ]];
    agentHost.setBuilder(new AgentBuilder()
      .withModelProvider(provider)
      .withSemanticSkillMatching(false));
    const session = await agentHost.createSession("partial failure history test");

    await agentHost.run("This partly fails", session.id);

    await expect(agentHost.getSessionStore().get(session.id)).resolves.toMatchObject({
      status: "failed",
      messages: [
        { role: "user", content: "This partly fails" },
        { role: "assistant", content: "Partial answer" },
      ],
    });
  });

  it("appends the final assistant text exactly once after a tool-call run", async () => {
    const provider = new CapturingModelProvider();
    provider.eventBatches = [
      [
        { type: "tool_call", toolCall: { id: "call-1", name: "lookup", arguments: {} } },
        { type: "text_done" },
      ],
      [
        { type: "text_chunk", text: "Final " },
        { type: "text_chunk", text: "answer" },
        { type: "text_done" },
      ],
    ];
    agentHost.setBuilder(new AgentBuilder().withModelProvider(provider));
    const session = await agentHost.createSession("assistant history test");

    await agentHost.run("Please look it up", session.id);

    const stored = await agentHost.getSessionStore().get(session.id);
    expect(stored?.messages).toEqual([
      { role: "user", content: "Please look it up" },
      {
        role: "assistant",
        content: "Final answer",
        presentation: { completionDurationMs: expect.any(Number) },
      },
    ]);
  });

  it("uses the session project remote tools after another project registers later", async () => {
    const provider = new CapturingModelProvider();
    agentHost.setBuilder(new AgentBuilder().withModelProvider(provider));

    agentHost.registerRemoteTools("project-a", [kidEarthTool]);
    const session = await agentHost.createSession("project A run", "project-a");
    agentHost.registerRemoteTools("project-b", [projectBTool]);

    await agentHost.run("生成课程", session.id);

    const remoteToolDefinition = provider.options?.tools?.find((tool) => tool.name === "remote_project_action");
    const systemPrompt = provider.messages.find((message) => message.role === "system")?.content;
    expect(remoteToolDefinition?.description).toContain("create_kid_earth_course");
    expect(remoteToolDefinition?.description).not.toContain("create_project_b_course");
    expect(systemPrompt).toContain("create_kid_earth_course");
    expect(systemPrompt).not.toContain("create_project_b_course");
  });

  it("does not expose last-registered remote tools to sessions without a projectId", async () => {
    const provider = new CapturingModelProvider();
    agentHost.setBuilder(new AgentBuilder().withModelProvider(provider));

    agentHost.registerRemoteTools("project-a", [kidEarthTool]);
    agentHost.registerRemoteTools("project-b", [projectBTool]);
    const session = await agentHost.createSession("unscoped run");

    await agentHost.run("生成课程", session.id);

    const remoteToolDefinition = provider.options?.tools?.find((tool) => tool.name === "remote_project_action");
    const systemPrompt = provider.messages.find((message) => message.role === "system")?.content;
    expect(remoteToolDefinition?.description).not.toContain("create_project_b_course");
    expect(systemPrompt).not.toContain("create_project_b_course");
  });

  it("does not mutate an already built project A tool registry after project B is registered", async () => {
    const providerA = new CapturingModelProvider();
    agentHost.setBuilder(new AgentBuilder().withModelProvider(providerA));
    agentHost.registerRemoteTools("project-a", [kidEarthTool]);
    const sessionA = await agentHost.createSession("project A run", "project-a");
    const agentA = await agentHost.getBuilder().withRemoteToolStore(agentHost.getRemoteToolStore(), "project-a").build();
    for await (const event of agentA.run("生成 A 课程", sessionA.id)) {
      if (event.type === "done") break;
    }
    const projectAToolBefore = providerA.options?.tools?.find((tool) => tool.name === "remote_project_action");

    const providerB = new CapturingModelProvider();
    agentHost.setBuilder(new AgentBuilder().withModelProvider(providerB));
    agentHost.registerRemoteTools("project-b", [projectBTool]);
    const sessionB = await agentHost.createSession("project B run", "project-b");
    await agentHost.run("生成 B 课程", sessionB.id);

    for await (const event of agentA.run("再次生成 A 课程", sessionA.id)) {
      if (event.type === "done") break;
    }

    const projectAToolAfter = providerA.options?.tools?.find((tool) => tool.name === "remote_project_action");
    expect(projectAToolBefore?.description).toContain("create_kid_earth_course");
    expect(projectAToolBefore?.description).not.toContain("create_project_b_course");
    expect(projectAToolAfter?.description).toContain("create_kid_earth_course");
    expect(projectAToolAfter?.description).not.toContain("create_project_b_course");
  });

  it("rejects AGENT_ACTION_TOKEN for arbitrary remote-tool registration", async () => {
    process.env.AGENT_ACTION_TOKEN = "server-action-token";
    delete process.env.AGENT_REMOTE_TOOLS_REGISTER_TOKEN;
    delete process.env.AGENT_SDK_REGISTRATION_TOKEN;

    const response = await registerRemoteTools(new Request("http://test/api/remote-tools/register", {
      method: "POST",
      headers: { authorization: "Bearer server-action-token" },
      body: JSON.stringify({ projectId: "remote-tools-test-project", tools: [kidEarthTool] }),
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "UNAUTHORIZED" });
  });

  it("accepts a dedicated remote-tool registration token from server callers for arbitrary URLs", async () => {
    process.env.AGENT_ACTION_TOKEN = "server-action-token";
    process.env.AGENT_REMOTE_TOOLS_REGISTER_TOKEN = "registration-token";

    const response = await registerRemoteTools(new Request("http://test/api/remote-tools/register", {
      method: "POST",
      headers: { authorization: "Bearer registration-token" },
      body: JSON.stringify({ projectId: "remote-tools-test-project", tools: [kidEarthTool] }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("accepts normal SDK token from browser callers only for the configured project and same-origin tool URLs", async () => {
    process.env.AGENT_SDK_TOKEN = "sdk-token";
    process.env.AGENT_PROJECT_ID = "kid-earth-learning";
    process.env.AGENT_SDK_ALLOWED_ORIGIN = "https://kid.example";

    const response = await registerRemoteTools(new Request("http://agent.test/api/remote-tools/register", {
      method: "POST",
      headers: { authorization: "Bearer sdk-token", origin: "https://kid.example" },
      body: JSON.stringify({
        projectId: "kid-earth-learning",
        tools: [{ ...kidEarthTool, url: "https://kid.example/api/agent-actions/create-course" }],
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("rejects SDK-token browser registration when project ownership is not configured", async () => {
    process.env.AGENT_SDK_TOKEN = "sdk-token";
    delete process.env.AGENT_PROJECT_ID;
    delete process.env.AGENT_SDK_ALLOWED_ORIGIN;
    delete process.env.AGENT_BROWSER_ORIGIN;

    const response = await registerRemoteTools(new Request("http://agent.test/api/remote-tools/register", {
      method: "POST",
      headers: { authorization: "Bearer sdk-token", origin: "https://attacker.example" },
      body: JSON.stringify({
        projectId: "kid-earth-learning",
        tools: [{ ...kidEarthTool, url: "https://attacker.example/api/agent-actions/create-course" }],
      }),
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "UNAUTHORIZED" });
  });

  it("rejects stolen SDK tokens from same-origin attacker tools when project ownership does not match", async () => {
    process.env.AGENT_SDK_TOKEN = "sdk-token";
    process.env.AGENT_PROJECT_ID = "kid-earth-learning";
    process.env.AGENT_SDK_ALLOWED_ORIGIN = "https://kid.example";

    const response = await registerRemoteTools(new Request("http://agent.test/api/remote-tools/register", {
      method: "POST",
      headers: { authorization: "Bearer sdk-token", origin: "https://attacker.example" },
      body: JSON.stringify({
        projectId: "kid-earth-learning",
        tools: [{ ...kidEarthTool, url: "https://attacker.example/api/agent-actions/create-course" }],
      }),
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "UNAUTHORIZED" });
  });

  it("allows privileged server tokens to register arbitrary project IDs and URLs", async () => {
    process.env.AGENT_REMOTE_TOOLS_REGISTER_TOKEN = "registration-token";
    process.env.AGENT_PROJECT_ID = "kid-earth-learning";
    process.env.AGENT_SDK_ALLOWED_ORIGIN = "https://kid.example";

    const response = await registerRemoteTools(new Request("http://agent.test/api/remote-tools/register", {
      method: "POST",
      headers: { authorization: "Bearer registration-token", origin: "https://attacker.example" },
      body: JSON.stringify({
        projectId: "other-project",
        tools: [{ ...kidEarthTool, url: "https://attacker.example/api/agent-actions/create-course" }],
      }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("rejects stolen SDK tokens when browser origin does not match every tool URL origin", async () => {
    process.env.AGENT_SDK_TOKEN = "sdk-token";

    const response = await registerRemoteTools(new Request("http://agent.test/api/remote-tools/register", {
      method: "POST",
      headers: { authorization: "Bearer sdk-token", origin: "https://attacker.example" },
      body: JSON.stringify({
        projectId: "kid-earth-learning",
        tools: [{ ...kidEarthTool, url: "https://kid.example/api/agent-actions/create-course" }],
      }),
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "UNAUTHORIZED" });
  });

  it("rejects SDK token registrations for arbitrary URLs from non-browser callers", async () => {
    process.env.AGENT_SDK_TOKEN = "sdk-token";

    const response = await registerRemoteTools(new Request("http://agent.test/api/remote-tools/register", {
      method: "POST",
      headers: { authorization: "Bearer sdk-token" },
      body: JSON.stringify({ projectId: "kid-earth-learning", tools: [kidEarthTool] }),
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "UNAUTHORIZED" });
  });

  it("rejects public and broad chat tokens for remote tool registration", async () => {
    process.env.AGENT_ACTION_TOKEN = "server-action-token";
    process.env.AGENT_REMOTE_TOOLS_REGISTER_TOKEN = "registration-token";
    process.env.AGENT_TOKEN = "chat-token";
    process.env.NEXT_PUBLIC_AGENT_TOKEN = "public-token";

    for (const token of ["chat-token", "public-token"]) {
      const response = await registerRemoteTools(new Request("http://test/api/remote-tools/register", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ projectId: "remote-tools-test-project", tools: [kidEarthTool] }),
      }));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: "UNAUTHORIZED" });
    }
  });

  it("fails closed when no registration, action, or SDK token is configured", async () => {
    delete process.env.AGENT_ACTION_TOKEN;
    delete process.env.AGENT_REMOTE_TOOLS_REGISTER_TOKEN;
    delete process.env.AGENT_SDK_REGISTRATION_TOKEN;
    delete process.env.AGENT_SDK_TOKEN;
    delete process.env.AGENT_TOKEN;
    delete process.env.NEXT_PUBLIC_AGENT_TOKEN;

    const response = await registerRemoteTools(new Request("http://test/api/remote-tools/register", {
      method: "POST",
      body: JSON.stringify({ projectId: "remote-tools-test-project", tools: [kidEarthTool] }),
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "UNAUTHORIZED" });
  });

  it("returns 400 when remote tool registration receives invalid JSON", async () => {
    const response = await registerRemoteTools(new Request("http://test/api/remote-tools/register", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: "{not-json",
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON" });
  });

  it("applies the session project id when replacing the builder", async () => {
    agentHost.registerRemoteTools("kid-earth-learning", [kidEarthTool]);
    const provider = new CapturingModelProvider();
    agentHost.setBuilder(new AgentBuilder().withModelProvider(provider));

    const session = await agentHost.createSession("set builder remote tools test", "kid-earth-learning");
    await agentHost.run("生成课程", session.id);

    const remoteToolDefinition = provider.options?.tools?.find((tool) => tool.name === "remote_project_action");
    expect(remoteToolDefinition?.description).toContain("create_kid_earth_course");
  });

  it("persists user messages with projected assistant messages after a run", async () => {
    const provider = new CapturingModelProvider();
    agentHost.setBuilder(new AgentBuilder().withModelProvider(provider));
    const session = await agentHost.createSession("history persistence test", "kid-earth-learning");

    await agentHost.run("第一轮：创建日本课程", session.id);

    await expect(agentHost.getSessionStore().get(session.id)).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "第一轮：创建日本课程" }),
      ]),
    });
  });
});
