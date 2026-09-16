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

  it("should respect max iterations", async () => {
    const loopingModel = {
      ...createMockModel(),
      callCount: 0,
      streamChat: async function* (this: { callCount: number }): AsyncIterable<StreamEvent> {
        // Always returns a tool call to force looping
        yield {
          type: "tool_call",
          toolCall: { id: `tc${this.callCount}`, name: "echo", arguments: { message: `msg${this.callCount}` } },
        };
        yield { type: "text_done" };
        this.callCount++;
      },
    };

    const loop = new AgentLoop(createConfig({ modelProvider: loopingModel, maxIterations: 3 }));
    const events: AgentEvent[] = [];

    for await (const event of loop.run("Loop", "test-session")) {
      events.push(event);
    }

    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls.length).toBeLessThanOrEqual(3);
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
