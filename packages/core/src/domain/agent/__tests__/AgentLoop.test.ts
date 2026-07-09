import { describe, it, expect, vi } from "vitest";
import { AgentLoop } from '../AgentLoop.js';
import type { AgentConfig, AgentEvent } from '../entities.js';
import type { IModelProvider, StreamEvent } from '../../model/entities.js';
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

  it("should surface empty model streams as errors", async () => {
    const emptyModel = {
      ...createMockModel(),
      streamChat: async function* (): AsyncIterable<StreamEvent> {},
    };

    const loop = new AgentLoop(createConfig({ modelProvider: emptyModel }));
    const events: AgentEvent[] = [];

    for await (const event of loop.run("test", "test-session")) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "error" && e.message === "Model stream ended without producing a response")).toBe(true);
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
