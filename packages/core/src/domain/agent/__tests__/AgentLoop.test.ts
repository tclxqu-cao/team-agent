import { describe, it, expect, vi } from "vitest";
import { AgentLoop } from '../AgentLoop.js';
import type { AgentConfig, AgentEvent } from '../entities.js';
import type { IModelProvider, StreamEvent, Message, StreamOptions } from '../../model/entities.js';
import { estimateRequestTokens } from '../../model/tokenBudget.js';
import type { IToolRegistry, IToolExecutor, ToolContext, ToolResult } from '../../tool/entities.js';
import type { IContextAssembler, AssembledContext } from '../../context/entities.js';
import type { IMemoryStore } from '../../memory/entities.js';

function createMockModel(): IModelProvider {
  return {
    providerId: "mock",
    modelId: "mock-model",
    streamChat: async function* (): AsyncIterable<StreamEvent> {
      yield { type: "text_chunk", text: "Hello" };
      yield { type: "text_done" };
    },
    countTokens: async () => 10,
    supportsModel: () => true,
  };
}

function createMockToolRegistry(): IToolRegistry & IToolExecutor {
  const tools = new Map();
  tools.set("echo", {
    name: "echo",
    description: "Echo tool",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    schema: { safeParse: (v: unknown) => ({ success: true as const, data: v }) },
    execute: async (p: Record<string, unknown>): Promise<ToolResult> => ({
      toolCallId: "", content: `echo: ${p.message}`,
    }),
  });

  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: (name: string) => tools.get(name),
    getAll: () => Array.from(tools.values()),
    getDefinitions: () => [{ name: "echo", description: "Echo tool", parameters: { type: "object", properties: { message: { type: "string" } } } }],
    execute: async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      const tool = tools.get(name);
      if (!tool) return { toolCallId: "", content: `Unknown tool: ${name}`, isError: true };
      return tool.execute(args, {} as ToolContext);
    },
    validate: () => true,
  };
}

function createMockContextAssembler(): IContextAssembler {
  return {
    assemble: async (): Promise<AssembledContext> => ({
      systemPrompt: "You are a helpful assistant.",
      systemSections: {
        systemBase: "You are a helpful assistant.",
        environment: "",
        projectContext: "",
        skills: "",
        embeddedTools: "",
        memory: "",
      },
      messages: [],
      tokenBudget: 100_000,
      tokenUsed: 50,
    }),
  };
}

function createMockMemoryStore(): IMemoryStore {
  return {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
    search: async () => [],
    generateContext: async () => "",
    getIndex: async () => "",
  };
}

function createConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    modelProvider: createMockModel(),
    toolRegistry: createMockToolRegistry(),
    toolExecutor: createMockToolRegistry(),
    contextAssembler: createMockContextAssembler(),
    skillRegistry: { register: async () => {}, unregister: () => {}, get: () => undefined, getAll: () => [], findMatching: () => [], getSkillPrompts: async () => "", setModelProvider: () => {} },
    memoryStore: createMockMemoryStore(),
    workingDirectory: "/tmp",
    maxIterations: 5,
    maxTokens: 100_000,
    ...overrides,
  };
}

describe("AgentLoop", () => {
  it("caps an oversized setting to the runtime 8192 window and reserves output and native tools", async () => {
    const model = createMockModel();
    model.getContextWindow = async () => 8192;
    model.countRequestTokens = async (messages, tools) => estimateRequestTokens(messages, tools);
    let options: StreamOptions | undefined;
    model.streamChat = async function* (messages, opts) {
      options = opts;
      expect(estimateRequestTokens(messages, opts?.tools) + opts!.maxTokens!).toBeLessThan(8192);
      yield { type: "text_chunk", text: "OK" };
    };
    const assembler = createMockContextAssembler();
    const assemble = vi.spyOn(assembler, "assemble");
    const events = [];
    for await (const event of new AgentLoop(createConfig({ modelProvider: model, contextAssembler: assembler, maxTokens: 8192000 })).run("你好", "8k")) events.push(event);
    expect(options?.maxTokens).toBe(1024);
    expect(assemble.mock.calls[0][0].tools).toBe("");
    expect(assemble.mock.calls[0][0].maxTokens).toBeLessThan(8192 - 1024);
    expect(events.find((e) => e.type === "context_usage")).toMatchObject({ usage: { maxTokens: 8192 } });
  });

  it("keeps the legacy 1/8 output heuristic when no profile ceiling is configured", async () => {
    const model = createMockModel();
    let maxTokens = 0;
    model.countRequestTokens = async () => 10;
    model.streamChat = async function* (_messages, options) {
      maxTokens = options!.maxTokens!;
      yield { type: "text_chunk", text: "OK" };
    };

    for await (const _ of new AgentLoop(createConfig({ modelProvider: model, maxTokens: 100_000 })).run("Hi", "legacy")) { /* consume */ }

    expect(maxTokens).toBe(12_500);
  });

  it("uses an explicit 32K profile output ceiling when context is available", async () => {
    const model = createMockModel();
    let maxTokens = 0;
    model.countRequestTokens = async () => 10;
    model.streamChat = async function* (_messages, options) {
      maxTokens = options!.maxTokens!;
      yield { type: "text_chunk", text: "OK" };
    };

    for await (const _ of new AgentLoop(createConfig({
      modelProvider: model,
      maxTokens: 100_000,
      maxOutputTokens: 32_768,
    })).run("Hi", "step")) { /* consume */ }

    expect(maxTokens).toBe(32_768);
  });

  it("does not auto-compact when only display reasoning exceeds the 60% threshold", async () => {
    const model = createMockModel();
    const assembler = createMockContextAssembler();
    assembler.assemble = async () => ({
      systemPrompt: "You are a helpful assistant.",
      systemSections: {
        systemBase: "You are a helpful assistant.",
        environment: "",
        projectContext: "",
        skills: "",
        embeddedTools: "",
        memory: "",
      },
      messages: [
        {
          role: "assistant",
          content: "prior answer",
          presentation: {
            reasoning: [{ itemId: "reasoning-1", sectionIndex: 0, text: "x".repeat(200_000) }],
          },
        },
        { role: "user", content: "continue" },
      ],
      tokenBudget: 100_000,
      tokenUsed: 50,
    });
    const events: AgentEvent[] = [];

    for await (const event of new AgentLoop(createConfig({
      modelProvider: model,
      contextAssembler: assembler,
      maxTokens: 100_000,
      maxOutputTokens: 32_768,
    })).run("continue", "display-reasoning")) events.push(event);

    expect(events.some((event) => (
      event.type === "runtime_progress" && event.progressId === "context-compaction"
    ))).toBe(false);
    expect(events.some((event) => event.type === "compacted")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "Hello" });
  });

  it("prunes an oversized recent tool result without breaking the tool exchange", async () => {
    const model = createMockModel();
    model.countRequestTokens = async (messages, tools) => estimateRequestTokens(messages, tools);
    let sent: Message[] = [];
    let calls = 0;
    model.streamChat = async function* (messages) {
      if (calls++ === 0) yield { type: "tool_call", toolCall: { id: "call1", name: "echo", arguments: {} } };
      else { sent = messages; yield { type: "text_chunk", text: "OK" }; }
    };
    const executor = createMockToolRegistry();
    executor.execute = async () => ({ toolCallId: "call1", content: "中文".repeat(10000) });
    for await (const _ of new AgentLoop(createConfig({ modelProvider: model, toolExecutor: executor, maxTokens: 8192 })).run("检查文件", "8k")) { /* consume */ }
    expect(sent.find((m) => m.toolCallId === "call1")?.content.length).toBeLessThan(600);
    expect(sent.find((m) => m.toolCalls)?.toolCalls?.[0].id).toBe("call1");
  });

  it("reports fixed overhead exceeding the budget without issuing an invalid chat request", async () => {
    const model = createMockModel();
    model.countRequestTokens = async () => 9000;
    const stream = vi.spyOn(model, "streamChat");
    const events = [];
    for await (const e of new AgentLoop(createConfig({ modelProvider: model, maxTokens: 8192 })).run("Hi", "8k")) events.push(e);
    expect(stream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "error", code: "context_limit" });
  });

  it("fits a 7248 token desktop prompt into 8192 by sizing the output to the remaining space", async () => {
    const model = createMockModel();
    model.countRequestTokens = async () => 7248;
    let maxTokens = 0;
    model.streamChat = async function* (_messages, options) {
      maxTokens = options!.maxTokens!;
      yield { type: "text_chunk", text: "OK" };
    };
    for await (const _ of new AgentLoop(createConfig({ modelProvider: model, maxTokens: 8192 })).run("Hi", "8k")) { /* consume */ }
    expect(maxTokens).toBe(688);
  });

  it("should complete a simple run without tools", async () => {
    const loop = new AgentLoop(createConfig());
    const events: AgentEvent[] = [];

    for await (const event of loop.run("Hi", "test-session")) {
      events.push(event);
    }

    const textChunks = events.filter((e) => e.type === "text_chunk");
    expect(textChunks.length).toBeGreaterThan(0);
    expect(textChunks[0].text).toBe("Hello");

    const doneEvent = events[events.length - 1];
    expect(doneEvent.type).toBe("done");
  });

  it("does not preload skills or run hidden semantic matching", async () => {
    const assembler = createMockContextAssembler();
    const assemble = vi.spyOn(assembler, "assemble");
    const getSkillPrompts = vi.fn(async () => "must not be injected");
    const skillRegistry = {
      register: () => {}, unregister: () => {}, get: () => undefined, getAll: () => [],
      findMatching: () => [], getSkillPrompts, setModelProvider: () => {},
    };

    for await (const _ of new AgentLoop(createConfig({ contextAssembler: assembler, skillRegistry })).run("1M context", "s1")) { /* consume */ }

    expect(getSkillPrompts).not.toHaveBeenCalled();
    expect(assemble.mock.calls[0][0].skillPrompts).toBe("");
  });

  it("loads an explicitly activated allowed skill without changing the user message", async () => {
    const assembler = createMockContextAssembler();
    const assemble = vi.spyOn(assembler, "assemble");
    const load = vi.fn(async (name: string, enabled: string[] | null | undefined) =>
      name === "portfolio-works" && enabled?.includes(name)
        ? { name, description: "Works", triggers: [], filePath: "", source: "custom" as const, prompt: "Return the works artifact." }
        : null);
    const skillRegistry = {
      register: () => {}, unregister: () => {}, get: () => undefined, getAll: () => [],
      findMatching: () => [], getSkillPrompts: async () => "", load, setModelProvider: () => {},
    };

    for await (const _ of new AgentLoop(createConfig({
      contextAssembler: assembler,
      skillRegistry,
      enabledSkills: ["portfolio-works"],
      activatedSkills: ["portfolio-works"],
    })).run("原始消息", "s1")) { /* consume */ }

    expect(load).toHaveBeenCalledWith("portfolio-works", ["portfolio-works"]);
    expect(assemble.mock.calls[0][0]).toMatchObject({
      userMessage: "原始消息",
      skillPrompts: "## Skill: portfolio-works\nReturn the works artifact.",
    });
  });

  it("loads an exact leading slash Skill without changing the user message", async () => {
    const assembler = createMockContextAssembler();
    const assemble = vi.spyOn(assembler, "assemble");
    const load = vi.fn(async (name: string) => name === "computer-use"
      ? { name, description: "Computer", triggers: [], filePath: "", source: "custom" as const, prompt: "Use computer." }
      : null);
    const skillRegistry = {
      register: () => {}, unregister: () => {}, get: () => undefined, getAll: () => [],
      findMatching: () => [], getSkillPrompts: async () => "", load, setModelProvider: () => {},
    };
    const input = "/computer-use 打开系统设置";

    for await (const _ of new AgentLoop(createConfig({ contextAssembler: assembler, skillRegistry })).run(input, "slash-skill")) { /* consume */ }

    expect(load).toHaveBeenCalledWith("computer-use", undefined);
    expect(assemble.mock.calls[0][0]).toMatchObject({
      userMessage: input,
      skillPrompts: "## Skill: computer-use\nUse computer.",
    });
  });

  it("does not preload a Skill for natural language or an unknown slash command", async () => {
    const assembler = createMockContextAssembler();
    const assemble = vi.spyOn(assembler, "assemble");
    const load = vi.fn(async () => null);
    const skillRegistry = {
      register: () => {}, unregister: () => {}, get: () => undefined, getAll: () => [],
      findMatching: () => [], getSkillPrompts: async () => "", load, setModelProvider: () => {},
    };

    for await (const _ of new AgentLoop(createConfig({ contextAssembler: assembler, skillRegistry })).run("帮我操作电脑", "plain-skill")) { /* consume */ }
    for await (const _ of new AgentLoop(createConfig({ contextAssembler: assembler, skillRegistry })).run("/missing do it", "missing-skill")) { /* consume */ }

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("missing", undefined);
    expect(assemble.mock.calls.map(([request]) => request.skillPrompts)).toEqual(["", ""]);
  });

  it("does not inject a slash Skill excluded by enabledSkills", async () => {
    const assembler = createMockContextAssembler();
    const assemble = vi.spyOn(assembler, "assemble");
    const load = vi.fn(async (_name: string, enabled: string[] | null | undefined) =>
      enabled?.includes("computer-use")
        ? { name: "computer-use", description: "Computer", triggers: [], filePath: "", source: "custom" as const, prompt: "Use computer." }
        : null);
    const skillRegistry = {
      register: () => {}, unregister: () => {}, get: () => undefined, getAll: () => [],
      findMatching: () => [], getSkillPrompts: async () => "", load, setModelProvider: () => {},
    };

    for await (const _ of new AgentLoop(createConfig({
      contextAssembler: assembler,
      skillRegistry,
      enabledSkills: ["another-skill"],
    })).run("/computer-use click", "blocked-slash-skill")) { /* consume */ }

    expect(load).toHaveBeenCalledWith("computer-use", ["another-skill"]);
    expect(assemble.mock.calls[0][0].skillPrompts).toBe("");
  });

  it("injects a Skill only once when trusted activation matches the slash command", async () => {
    const assembler = createMockContextAssembler();
    const assemble = vi.spyOn(assembler, "assemble");
    const load = vi.fn(async (name: string) => ({
      name,
      description: "Computer",
      triggers: [],
      filePath: "",
      source: "custom" as const,
      prompt: "Use computer.",
    }));
    const skillRegistry = {
      register: () => {}, unregister: () => {}, get: () => undefined, getAll: () => [],
      findMatching: () => [], getSkillPrompts: async () => "", load, setModelProvider: () => {},
    };

    for await (const _ of new AgentLoop(createConfig({
      contextAssembler: assembler,
      skillRegistry,
      activatedSkills: ["computer-use"],
    })).run("/computer-use click", "dedupe-slash-skill")) { /* consume */ }

    expect(load).toHaveBeenCalledTimes(1);
    expect(assemble.mock.calls[0][0].skillPrompts).toBe("## Skill: computer-use\nUse computer.");
  });

  it("does not expose Skill tools when the exact Skill allowlist is empty", async () => {
    const model = createMockModel();
    let toolNames: string[] = [];
    model.streamChat = async function* (_messages, options) {
      toolNames = (options?.tools ?? []).map((tool) => tool.name);
      yield { type: "text_chunk", text: "OK" };
    };
    const registry = createMockToolRegistry();
    registry.getDefinitions = () => [
      { name: "echo", description: "Echo", parameters: { type: "object" } },
      { name: "skill_discover", description: "Discover", parameters: { type: "object" } },
      { name: "skill_load", description: "Load", parameters: { type: "object" } },
    ];

    for await (const _ of new AgentLoop(createConfig({
      modelProvider: model,
      toolRegistry: registry,
      toolExecutor: registry,
      enabledTools: ["echo"],
      enabledSkills: [],
      allowUnlistedDynamicTools: false,
    })).run("hello", "no-skills")) { /* consume */ }

    expect(toolNames).toEqual(["echo"]);
  });

  it("emits complete context usage before model output", async () => {
    const loop = new AgentLoop(createConfig());
    const events: AgentEvent[] = [];

    for await (const event of loop.run("Hi", "test-session", ["data:image/png;base64,abc"])) {
      events.push(event);
    }

    const usageIndex = events.findIndex((event) => event.type === "context_usage");
    const textIndex = events.findIndex((event) => event.type === "text_chunk");
    expect(usageIndex).toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeLessThan(textIndex);
    const usageEvent = events[usageIndex];
    expect(usageEvent.type).toBe("context_usage");
    if (usageEvent.type === "context_usage") {
      expect(usageEvent.usage.providerId).toBe("mock");
      expect(usageEvent.usage.modelId).toBe("mock-model");
      expect(usageEvent.usage.segments.find((s) => s.category === "images")?.tokens).toBe(1000);
      expect(usageEvent.usage.segments.find((s) => s.category === "nativeToolDefinitions")?.tokens).toBeGreaterThan(0);
    }
  });

  it("should handle tool calls from model", async () => {
    let callCount = 0;
    const modelWithTool = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          // First call: use a tool
          yield {
            type: "tool_call",
            toolCall: { id: "tc1", name: "echo", arguments: { message: "test" } },
          };
          yield { type: "text_done" };
        } else {
          // Subsequent calls: text response, no tools
          yield { type: "text_chunk", text: "Done with echo" };
          yield { type: "text_done" };
        }
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: modelWithTool }));
    const events: AgentEvent[] = [];

    for await (const event of loop.run("Use echo", "test-session")) {
      events.push(event);
    }

    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents.length).toBe(1);

    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    expect(toolResultEvents.length).toBe(1);
    expect((toolResultEvents[0] as unknown as { result: ToolResult }).result.content).toBe("echo: test");

    const usageEvents = events.filter((e) => e.type === "context_usage");
    expect(usageEvents).toHaveLength(2);
    const secondUsage = usageEvents[1];
    expect(secondUsage.type).toBe("context_usage");
    if (secondUsage.type === "context_usage") {
      expect(secondUsage.usage.requestIndex).toBe(2);
      expect(secondUsage.usage.segments.find((s) => s.category === "toolCalls")?.tokens).toBeGreaterThan(0);
      expect(secondUsage.usage.segments.find((s) => s.category === "toolResults")?.tokens).toBeGreaterThan(0);
    }
  });

  it("delivers model-only tool data once without exposing it to events, diagnostics, or checkpoints", async () => {
    let request = 0;
    let secondRequest: Message[] = [];
    const model = {
      ...createMockModel(),
      streamChat: async function* (messages: Message[]): AsyncIterable<StreamEvent> {
        if (request++ === 0) {
          yield { type: "tool_call", toolCall: { id: "visual-1", name: "echo", arguments: {} } };
          yield { type: "tool_call", toolCall: { id: "visual-2", name: "echo", arguments: {} } };
          return;
        }
        secondRequest = messages;
        yield { type: "text_chunk", text: "seen" };
      },
    };
    const executor = createMockToolRegistry();
    executor.execute = async () => ({
      toolCallId: "",
      content: "observed",
      modelContent: "AX_SECRET_TREE",
      modelAttachments: [{
        type: "image",
        mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,secret",
        width: 2,
        height: 1,
      }],
    });
    let savedCheckpoint = "";
    const diagnostics: unknown[] = [];
    const events: AgentEvent[] = [];
    for await (const event of new AgentLoop(createConfig({
      modelProvider: model,
      toolExecutor: executor,
      diagnosticObserver: (_sessionId, observation) => diagnostics.push(observation),
      runCheckpointStore: {
        load: async () => null,
        save: async (checkpoint) => { savedCheckpoint = JSON.stringify(checkpoint); },
        clear: async () => {},
      },
    })).run("look", "visual-session")) events.push(event);

    const assistantIndex = secondRequest.findIndex((message) => message.toolCalls?.length === 2);
    const toolIndices = secondRequest
      .map((message, index) => message.role === "tool" ? index : -1)
      .filter((index) => index >= 0);
    const observationIndex = secondRequest.findIndex((message) => message.name === "__tool_observation__");
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndices).toHaveLength(2);
    expect(observationIndex).toBeGreaterThan(Math.max(...toolIndices));
    expect(secondRequest[observationIndex].content).toContain("AX_SECRET_TREE");
    expect(secondRequest[observationIndex].images).toEqual([
      "data:image/jpeg;base64,secret",
      "data:image/jpeg;base64,secret",
    ]);
    const publicEvents = JSON.stringify(events);
    expect(publicEvents).not.toContain("AX_SECRET_TREE");
    expect(publicEvents).not.toContain("base64,secret");
    expect(publicEvents).toContain('"mimeType":"image/jpeg"');
    expect(JSON.stringify(diagnostics)).not.toContain("AX_SECRET_TREE");
    expect(savedCheckpoint).not.toContain("base64,secret");
    expect(savedCheckpoint).not.toContain("AX_SECRET_TREE");
    expect(savedCheckpoint).not.toContain("__tool_observation__");
  });

  it("keeps model-only tool text out of automatic compaction summaries", async () => {
    const mainRequests: Message[][] = [];
    const summarizerRequests: Message[][] = [];
    let mainRequest = 0;
    const model: IModelProvider = {
      ...createMockModel(),
      countRequestTokens: async (messages) =>
        JSON.stringify(messages).includes("AX_SECRET_TREE") ? 70_000 : 100,
      streamChat: async function* (messages: Message[]): AsyncIterable<StreamEvent> {
        if (messages[0]?.content.includes("summarizing a conversation")) {
          summarizerRequests.push(messages);
          yield { type: "text_chunk", text: "safe compacted history" };
          return;
        }
        mainRequests.push(messages);
        if (mainRequest++ === 0) {
          yield { type: "tool_call", toolCall: { id: "private-1", name: "echo", arguments: {} } };
          yield { type: "text_done" };
          return;
        }
        yield { type: "text_chunk", text: "done" };
        yield { type: "text_done" };
      },
    };
    const assembler = createMockContextAssembler();
    assembler.assemble = async () => ({
      systemPrompt: "You are a helpful assistant.",
      systemSections: {
        systemBase: "You are a helpful assistant.",
        environment: "",
        projectContext: "",
        skills: "",
        embeddedTools: "",
        memory: "",
      },
      messages: [
        ...Array.from({ length: 6 }, (_, index): Message[] => [
          { role: "user", content: `old question ${index}` },
          { role: "assistant", content: `old answer ${index}` },
        ]).flat(),
        { role: "user", content: "inspect" },
      ],
      tokenBudget: 100_000,
      tokenUsed: 50,
    });
    const executor = createMockToolRegistry();
    executor.execute = async () => ({
      toolCallId: "",
      content: "private observation available",
      modelContent: "AX_SECRET_TREE",
    });

    const events: AgentEvent[] = [];
    for await (const event of new AgentLoop(createConfig({
      modelProvider: model,
      contextAssembler: assembler,
      toolExecutor: executor,
    })).run("inspect", "compaction-private")) events.push(event);

    expect(summarizerRequests.length).toBeGreaterThan(0);
    expect(JSON.stringify(summarizerRequests)).not.toContain("AX_SECRET_TREE");
    expect(JSON.stringify(events)).not.toContain("AX_SECRET_TREE");
    expect(JSON.stringify(mainRequests[1])).toContain("AX_SECRET_TREE");
    const progressIndex = events.findIndex((event) => (
      event.type === "runtime_progress" && event.progressId === "context-compaction"
    ));
    const compactedIndex = events.findIndex((event) => event.type === "compacted");
    const nextUsageIndex = events.findIndex((event, index) => (
      index > progressIndex && event.type === "context_usage"
    ));
    expect(progressIndex).toBeGreaterThanOrEqual(0);
    expect(events[progressIndex]).toMatchObject({
      type: "runtime_progress",
      phase: "status",
      label: "正在压缩上下文",
    });
    expect(compactedIndex).toBeGreaterThan(progressIndex);
    expect(nextUsageIndex).toBeGreaterThan(compactedIndex);
  });

  it("keeps twelve sequential tool rounds intact and exposes failures to the next model request", async () => {
    let request = 0;
    const seenMessages: Message[][] = [];
    const model = {
      ...createMockModel(),
      streamChat: async function* (messages: Message[]): AsyncIterable<StreamEvent> {
        seenMessages.push(messages.map((message) => ({ ...message })));
        if (request < 12) {
          request += 1;
          yield { type: "tool_call", toolCall: { id: `round-${request}`, name: "echo", arguments: { message: `step-${request}` } } };
          yield { type: "text_done" };
          return;
        }
        yield { type: "text_chunk", text: "completed-12-rounds" };
        yield { type: "text_done" };
      },
    };
    let execution = 0;
    const executor = createMockToolRegistry();
    executor.execute = async (_name, args) => {
      execution += 1;
      return execution === 1
        ? { toolCallId: "", content: "first attempt failed", isError: true }
        : { toolCallId: "", content: `ok:${String(args.message)}` };
    };
    const events: AgentEvent[] = [];

    for await (const event of new AgentLoop(createConfig({
      modelProvider: model,
      toolExecutor: executor,
      maxIterations: 13,
    })).run("run twelve steps", "twelve-rounds")) events.push(event);

    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(12);
    expect(events.filter((event) => event.type === "tool_result")).toHaveLength(12);
    expect(seenMessages[1].find((message) => message.toolCallId === "round-1")).toMatchObject({
      role: "tool",
      content: "first attempt failed",
      isError: true,
    });
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "completed-12-rounds" });
  });

  it("emits one context snapshot when a request is retried", async () => {
    let calls = 0;
    const retryModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        calls++;
        if (calls === 1) throw new Error("network temporary");
        yield { type: "text_chunk", text: "Recovered" };
        yield { type: "text_done" };
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: retryModel, streamMaxRetries: 1 }));
    const events: AgentEvent[] = [];
    for await (const event of loop.run("Retry", "test-session")) events.push(event);

    expect(calls).toBe(2);
    expect(events.filter((event) => event.type === "context_usage")).toHaveLength(1);
  });

  it("does not retry after partial output reaches the caller", async () => {
    let calls = 0;
    const partialModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        calls++;
        yield { type: "text_chunk", text: "partial" };
        throw new Error("network temporary");
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: partialModel, streamMaxRetries: 1 }));
    const events: AgentEvent[] = [];
    for await (const event of loop.run("Retry", "test-session")) events.push(event);

    expect(calls).toBe(1);
    expect(events.filter((event) => event.type === "text_chunk")).toHaveLength(1);
    expect(events.some((event) => event.type === "error" && event.message === "network temporary")).toBe(true);
  });

  it("codes a transport timeout before output after exhausting the configured retry", async () => {
    let calls = 0;
    const timeoutModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        calls++;
        throw new Error("The operation was aborted due to timeout");
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: timeoutModel, streamMaxRetries: 1 }));
    const events: AgentEvent[] = [];
    for await (const event of loop.run("Retry", "timeout-before-output")) events.push(event);

    expect(calls).toBe(2);
    expect(events).toContainEqual({
      type: "error",
      code: "model_transport_timeout",
      message: "The operation was aborted due to timeout",
    });
  });

  it("codes but does not retry a transport timeout after partial output", async () => {
    let calls = 0;
    const partialTimeoutModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        calls++;
        yield { type: "text_chunk", text: "partial" };
        yield { type: "error", message: "Stream chunk timeout: no data received for 60s" };
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: partialTimeoutModel, streamMaxRetries: 1 }));
    const events: AgentEvent[] = [];
    for await (const event of loop.run("Retry", "timeout-after-output")) events.push(event);

    expect(calls).toBe(1);
    expect(events.filter((event) => event.type === "text_chunk")).toHaveLength(1);
    expect(events).toContainEqual({
      type: "error",
      code: "model_transport_timeout",
      message: "Stream chunk timeout: no data received for 60s",
    });
  });

  it.each([10, 20])("uses one tool-disabled request to finalize after %i allowed tool iterations", async (maxIterations) => {
    const requests: Array<{ messages: Message[]; options?: StreamOptions }> = [];
    let request = 0;
    const model = {
      ...createMockModel(),
      streamChat: async function* (messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent> {
        requests.push({ messages, options });
        request++;
        if (request <= maxIterations) {
          yield { type: "tool_call", toolCall: { id: `tc${request}`, name: "echo", arguments: { message: `msg${request}` } } };
          yield { type: "text_done" };
          return;
        }
        yield { type: "text_chunk", text: "final answer from collected evidence" };
        yield { type: "text_done" };
      },
    };
    const executor = createMockToolRegistry();
    const execute = vi.spyOn(executor, "execute");
    const observations: Array<Record<string, unknown>> = [];
    const events: AgentEvent[] = [];

    for await (const event of new AgentLoop(createConfig({
      modelProvider: model,
      toolExecutor: executor,
      maxIterations,
      diagnosticObserver: (_sessionId, observation) => observations.push(observation as Record<string, unknown>),
    })).run("Inspect, then answer", "finalize-after-tools")) events.push(event);

    expect(execute).toHaveBeenCalledTimes(maxIterations);
    expect(requests).toHaveLength(maxIterations + 1);
    expect(requests[0].options?.tools?.map((tool) => tool.name)).toContain("echo");
    expect(requests[maxIterations - 1].options?.tools?.map((tool) => tool.name)).toContain("echo");
    expect(requests[maxIterations].options?.tools).toBeUndefined();
    expect(requests[maxIterations].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", toolCallId: `tc${maxIterations}`, content: `echo: msg${maxIterations}` }),
      expect.objectContaining({ name: "__iteration_finalization__", content: expect.stringContaining("Do not call tools") }),
    ]));
    expect(observations).toContainEqual(expect.objectContaining({
      type: "request_context",
      iteration: maxIterations + 1,
      finalizationOnly: true,
    }));
    expect(observations.some((observation) => observation.type === "iteration_limit")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "final answer from collected evidence" });
  });

  it("treats zero maximum iterations as unlimited", async () => {
    const requests: Array<{ options?: StreamOptions }> = [];
    let request = 0;
    const model = {
      ...createMockModel(),
      streamChat: async function* (_messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent> {
        requests.push({ options });
        request++;
        if (request <= 55) {
          yield { type: "tool_call", toolCall: { id: `tc${request}`, name: "echo", arguments: { message: `msg${request}` } } };
          yield { type: "text_done" };
          return;
        }
        yield { type: "text_chunk", text: "completed without an iteration cap" };
        yield { type: "text_done" };
      },
    };
    const observations: Array<Record<string, unknown>> = [];
    const events: AgentEvent[] = [];

    for await (const event of new AgentLoop(createConfig({
      modelProvider: model,
      toolExecutor: createMockToolRegistry(),
      maxIterations: 0,
      diagnosticObserver: (_sessionId, observation) => observations.push(observation as Record<string, unknown>),
    })).run("Continue until complete", "unlimited-iterations")) events.push(event);

    expect(requests).toHaveLength(56);
    expect(requests[54].options?.tools?.map((tool) => tool.name)).toContain("echo");
    expect(observations.some((observation) => observation.type === "iteration_limit")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "completed without an iteration cap" });
  });

  it("finalizes a restored ready checkpoint at the tool-iteration budget without replaying tools", async () => {
    const requests: Array<{ messages: Message[]; options?: StreamOptions }> = [];
    const model = {
      ...createMockModel(),
      streamChat: async function* (messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent> {
        requests.push({ messages, options });
        yield { type: "text_chunk", text: "recovered final answer" };
        yield { type: "text_done" };
      },
    };
    const executor = createMockToolRegistry();
    const execute = vi.spyOn(executor, "execute");
    const savedPhases: string[] = [];
    const events: AgentEvent[] = [];

    for await (const event of new AgentLoop(createConfig({
      modelProvider: model,
      toolExecutor: executor,
      maxIterations: 10,
      runCheckpointStore: {
        load: async () => ({
          schema: 1,
          sessionId: "restored-at-budget",
          input: "Inspect, then answer",
          workingDirectory: "/tmp",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Inspect, then answer" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "tc10", name: "echo", arguments: { message: "last" } }],
            },
            { role: "tool", toolCallId: "tc10", name: "echo", content: "echo: last" },
          ],
          iteration: 10,
          phase: "ready",
          pendingToolIds: [],
        }),
        save: async (checkpoint) => { savedPhases.push(checkpoint.phase); },
      },
    })).run("Inspect, then answer", "restored-at-budget")) events.push(event);

    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0].options?.tools).toBeUndefined();
    expect(requests[0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", toolCallId: "tc10", content: "echo: last" }),
      expect.objectContaining({ name: "__iteration_finalization__" }),
    ]));
    expect(savedPhases).toContain("completed");
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "recovered final answer" });
  });

  it("does not add a finalization request when the model completes within the iteration budget", async () => {
    const requests: Array<{ messages: Message[]; options?: StreamOptions }> = [];
    let request = 0;
    const model = {
      ...createMockModel(),
      streamChat: async function* (messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent> {
        requests.push({ messages, options });
        request++;
        if (request === 1) {
          yield { type: "tool_call", toolCall: { id: "tc1", name: "echo", arguments: { message: "needed" } } };
          yield { type: "text_done" };
          return;
        }
        yield { type: "text_chunk", text: "completed normally" };
        yield { type: "text_done" };
      },
    };
    const events: AgentEvent[] = [];

    for await (const event of new AgentLoop(createConfig({
      modelProvider: model,
      maxIterations: 3,
    })).run("One check", "within-budget")) events.push(event);

    expect(requests).toHaveLength(2);
    expect(requests[1].options?.tools?.map((tool) => tool.name)).toContain("echo");
    expect(requests[1].messages.some((message) => message.name === "__iteration_finalization__")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "completed normally" });
  });

  it("does not execute tool calls emitted during the tool-disabled finalization request", async () => {
    const loopingModel = {
      ...createMockModel(),
      callCount: 0,
      streamChat: async function* (this: { callCount: number }, _messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent> {
        // Always returns a tool call to force looping
        if (this.callCount === 3) expect(options?.tools).toBeUndefined();
        yield {
          type: "tool_call",
          toolCall: { id: `tc${this.callCount}`, name: "echo", arguments: { message: `msg${this.callCount}` } },
        };
        yield { type: "text_done" };
        this.callCount++;
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: loopingModel, maxIterations: 3 }));
    const execute = vi.spyOn(loopingModel, "streamChat");
    const events: AgentEvent[] = [];

    for await (const event of loop.run("Loop", "test-session")) {
      events.push(event);
    }

    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(execute).toHaveBeenCalledTimes(4);
    expect(toolCalls).toHaveLength(3);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "Reached max iterations (3)" });
  });

  it("should handle model errors gracefully", async () => {
    const errorModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "error", message: "API error" };
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: errorModel }));
    const events: AgentEvent[] = [];

    for await (const event of loop.run("test", "test-session")) {
      events.push(event);
    }

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents.length).toBeGreaterThan(0);
  });

  it("preserves structured provider error codes for Harness classification", async () => {
    const errorModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "error", code: "desktop_offline", message: "desktop unavailable" };
      },
    };
    const events: AgentEvent[] = [];

    for await (const event of new AgentLoop(createConfig({ modelProvider: errorModel })).run("test", "test-session")) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "error", code: "desktop_offline", message: "desktop unavailable" });
  });

  it("should retry an empty model stream once and recover", async () => {
    let calls = 0;
    const recoveringModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        calls++;
        if (calls === 1) {
          yield { type: "text_done" };
          return;
        }
        yield { type: "text_chunk", text: "Recovered" };
        yield { type: "text_done" };
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: recoveringModel, streamMaxRetries: 0 }));
    const events: AgentEvent[] = [];

    for await (const event of loop.run("test", "test-session")) {
      events.push(event);
    }

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "text_chunk" && e.text === "Recovered")).toBe(true);
    expect(events.filter((e) => e.type === "text_done")).toHaveLength(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("maps model reasoning to one stable reasoning item before answer text", async () => {
    const reasoningModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "reasoning_delta", text: "Inspect " };
        yield { type: "reasoning_delta", text: "the request" };
        yield { type: "text_chunk", text: "Answer" };
        yield { type: "text_done" };
      },
    };
    const events: AgentEvent[] = [];

    for await (const event of new AgentLoop(createConfig({ modelProvider: reasoningModel })).run("test", "reasoning-session")) {
      events.push(event);
    }

    const reasoning = events.filter((event): event is Extract<AgentEvent, { type: "reasoning_summary_delta" }> =>
      event.type === "reasoning_summary_delta");
    expect(reasoning).toHaveLength(2);
    expect(new Set(reasoning.map((event) => event.itemId)).size).toBe(1);
    expect(reasoning.map((event) => event.delta).join("")).toBe("Inspect the request");
    expect(events.some((event) => event.type === "text_chunk" && event.text === "Answer")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "Answer" });
  });

  it("does not count reasoning-only streams as successful output", async () => {
    let calls = 0;
    const reasoningOnlyModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        calls++;
        yield { type: "reasoning_delta", text: `attempt-${calls}` };
        yield { type: "text_done" };
      },
    };
    const events: AgentEvent[] = [];

    for await (const event of new AgentLoop(createConfig({ modelProvider: reasoningOnlyModel })).run("test", "reasoning-only-session")) {
      events.push(event);
    }

    expect(calls).toBe(2);
    expect(events.filter((event) => event.type === "reasoning_summary_delta")).toHaveLength(2);
    expect(events.some((event) => event.type === "error" && event.message === "Model stream ended without producing a response after retry")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "" });
  });

  it("does not save a completed checkpoint after a reasoning truncation error", async () => {
    const phases: string[] = [];
    const truncatedModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        yield { type: "reasoning_delta", text: "unfinished" };
        yield { type: "error", message: "输出被截断" };
      },
    };
    const events: AgentEvent[] = [];

    for await (const event of new AgentLoop(createConfig({
      modelProvider: truncatedModel,
      runCheckpointStore: {
        load: async () => null,
        save: async (checkpoint) => { phases.push(checkpoint.phase); },
        clear: async () => {},
      },
    })).run("test", "truncated-reasoning-session")) events.push(event);

    expect(phases).not.toContain("completed");
    expect(events.some((event) => event.type === "error" && event.message === "输出被截断")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "" });
  });

  it("should abort before retrying an empty model stream when cancelled during backoff", async () => {
    let calls = 0;
    const emptyModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        calls++;
        yield { type: "text_done" };
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: emptyModel }));
    const events: AgentEvent[] = [];

    for await (const event of loop.run("test", "test-session")) {
      events.push(event);
      if (event.type === "thinking" && event.message.startsWith("Retrying")) {
        loop.abort();
      }
    }

    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "turn_aborted")).toBe(true);
  });

  it("should surface an error when the empty model stream persists after retry", async () => {
    let calls = 0;
    const emptyModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        calls++;
        yield { type: "text_done" };
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: emptyModel }));
    const events: AgentEvent[] = [];

    for await (const event of loop.run("test", "test-session")) {
      events.push(event);
    }

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "error" && e.message === "Model stream ended without producing a response after retry")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("should stop loop when aborted mid-run", async () => {
    let calls = 0;
    const loopingModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {
        calls++;
        // Always return a tool call to keep the loop going
        yield {
          type: "tool_call",
          toolCall: { id: `tc${calls}`, name: "echo", arguments: { message: `msg${calls}` } },
        };
        yield { type: "text_done" };
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: loopingModel, maxIterations: 10 }));
    const events: AgentEvent[] = [];

    for await (const event of loop.run("test", "test-session")) {
      events.push(event);
      // Abort after the tool result comes back (after first full iteration)
      if (event.type === "tool_result") {
        loop.abort();
      }
    }

    // With abort, should stop at iteration 2 (much less than maxIterations)
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBeLessThan(3);

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
  });
});

describe('private Harness context observer', () => {
  it('observes the actual request context without changing public events or propagating observer failure', async () => {
    const observations: unknown[] = [];
    const agent = new AgentLoop(createConfig({ diagnosticObserver: (sessionId, observation) => {
      expect(sessionId).toBe('diagnostic-session'); observations.push(observation); throw new Error('storage unavailable');
    } }));
    const events: AgentEvent[] = [];
    for await (const event of agent.run('keep user constraint', 'diagnostic-session')) events.push(event);
    expect(observations).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'request_context', iteration: 1,
      messages: expect.arrayContaining([expect.objectContaining({ preview: 'keep user constraint' })]) })]));
    expect(events.some(event => event.type === 'done')).toBe(true);
    expect(events.some(event => event.type === 'error')).toBe(false);
  });
});
