import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AgentBuilder,
  PermissionAwareToolExecutor,
  ToolPermissionGate,
  type AgentEvent,
  type IModelProvider,
  type Message,
  type StreamEvent,
  type StreamOptions,
} from "@agent/core";
import { COMPUTER_USE_SKILL_NAME, type ComputerRuntimePort } from "@agent/computer-use";
import { describe, expect, it, vi } from "vitest";
import { isCompatibleComputerRuntime, registerCustomerComputerSkill, registerCustomerComputerTool } from "./computer-use";

const observation = {
  source: "accessibility" as const,
  revision: "ax_1",
  coverage: "complete" as const,
  app: { name: "Fixture", bundleId: "dev.fixture", pid: 1 },
  nodes: [],
};

function runtime(status: Awaited<ReturnType<ComputerRuntimePort["status"]>>): ComputerRuntimePort {
  return {
    status: vi.fn(async () => status),
    execute: vi.fn(async () => observation),
  };
}

describe("Customer Agent computer tool registration", () => {
  it("registers the built-in Skill even when the desktop relay is offline", async () => {
    const builder = new AgentBuilder();
    registerCustomerComputerSkill(builder);
    await registerCustomerComputerTool(builder, { probe: runtime({ available: false }) });

    await expect(builder.getSkillRegistry().load(COMPUTER_USE_SKILL_NAME)).resolves.toMatchObject({
      name: COMPUTER_USE_SKILL_NAME,
    });
    expect(builder.getToolRegistry().get("computer")).toBeUndefined();
  });

  it("accepts only an available compatible macOS relay", () => {
    expect(isCompatibleComputerRuntime({ available: true, platform: "darwin", protocolVersion: 1 })).toBe(true);
    expect(isCompatibleComputerRuntime({ available: false, platform: "darwin", protocolVersion: 1 })).toBe(false);
    expect(isCompatibleComputerRuntime({ available: true, platform: "linux", protocolVersion: 1 })).toBe(false);
    expect(isCompatibleComputerRuntime({ available: true, platform: "darwin", protocolVersion: 2 })).toBe(false);
  });

  it("registers computer with direct authorization after a compatible probe", async () => {
    const builder = new AgentBuilder();
    const probe = runtime({ available: true, platform: "darwin", protocolVersion: 1 });
    const executionRuntime = runtime({ available: true, platform: "darwin", protocolVersion: 1 });
    await expect(registerCustomerComputerTool(builder, { probe, runtime: executionRuntime }))
      .resolves.toMatchObject({ registered: true });
    expect(builder.getToolRegistry().get("computer")?.authorization).toBe("direct");
  });

  it("executes computer from an explicitly invoked built-in Skill", async () => {
    const requests: Array<{ messages: Message[]; options?: StreamOptions }> = [];
    let request = 0;
    const model: IModelProvider = {
      providerId: "test",
      modelId: "test-model",
      async *streamChat(messages, options): AsyncIterable<StreamEvent> {
        requests.push({ messages, options });
        if (request++ === 0) {
          yield {
            type: "tool_call",
            toolCall: { id: "computer-observe-1", name: "computer", arguments: { action: "observe" } },
          };
          return;
        }
        yield { type: "text_chunk", text: "Observed Fixture." };
        yield { type: "text_done" };
      },
      async countTokens() { return 1; },
      supportsModel() { return true; },
    };
    const executionRuntime = runtime({ available: true, platform: "darwin", protocolVersion: 1 });
    const builder = new AgentBuilder().withModelProvider(model).withSemanticSkillMatching(false);
    const agent = await builder.build();

    registerCustomerComputerSkill(builder);
    await registerCustomerComputerTool(builder, {
      probe: runtime({ available: true, platform: "darwin", protocolVersion: 1 }),
      runtime: executionRuntime,
    });

    const events: AgentEvent[] = [];
    for await (const event of agent.run(
      "/computer-use 只观察当前前台应用并告诉我应用名称，不执行其他操作",
      "computer-use-integration",
    )) {
      events.push(event);
    }

    const firstRequestSystemPrompt = requests[0]?.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n") ?? "";
    expect(firstRequestSystemPrompt).toContain("## Skill: computer-use");
    expect(requests[0]?.options?.tools?.map((tool) => tool.name)).toContain("computer");
    expect(executionRuntime.execute).toHaveBeenCalledWith(
      { action: "observe" },
      expect.any(AbortSignal),
    );
    expect(events).toContainEqual({
      type: "tool_call",
      toolCall: { id: "computer-observe-1", name: "computer", arguments: { action: "observe" } },
    });
    expect(requests[1]?.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      toolCallId: "computer-observe-1",
      content: expect.stringContaining('"source":"accessibility"'),
    }));
    expect(events).toContainEqual({ type: "done", finalText: "Observed Fixture." });
  });

  it.each([
    { available: false },
    { available: true, platform: "linux", protocolVersion: 1 },
    { available: true, platform: "darwin", protocolVersion: 2 },
  ])("skips an unavailable or incompatible relay: %o", async (status) => {
    const builder = new AgentBuilder();
    await expect(registerCustomerComputerTool(builder, { probe: runtime(status) }))
      .resolves.toMatchObject({ registered: false });
    expect(builder.getToolRegistry().get("computer")).toBeUndefined();
  });

  it("treats a failed probe as offline", async () => {
    const builder = new AgentBuilder();
    const probe: ComputerRuntimePort = {
      status: vi.fn(async () => { throw new Error("offline"); }),
      execute: vi.fn(async () => observation),
    };
    await expect(registerCustomerComputerTool(builder, { probe }))
      .resolves.toEqual({ registered: false, status: { available: false } });
  });

  it("bypasses the Customer Agent approval request for computer", async () => {
    const builder = new AgentBuilder();
    const executionRuntime = runtime({ available: true, platform: "darwin", protocolVersion: 1 });
    await registerCustomerComputerTool(builder, {
      probe: runtime({ available: true, platform: "darwin", protocolVersion: 1 }),
      runtime: executionRuntime,
    });
    const requestApproval = vi.fn(async () => "deny" as const);
    const gate = new ToolPermissionGate({ resolveMode: () => "request-approval", requestApproval });
    expect(builder.getToolRegistry().getAuthorizationPolicy("computer")).toBe("direct");
    const executor = new PermissionAwareToolExecutor(builder.getToolRegistry(), gate);
    const result = await executor.execute("computer", { action: "observe" }, {
      sessionId: "session-1",
      workingDirectory: "/tmp",
    });
    expect(result.content).toContain('"source":"accessibility"');
    expect(result.isError).toBeUndefined();
    expect(executionRuntime.execute).toHaveBeenCalledOnce();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("does not couple native runtime service or adapters to computer-use", async () => {
    const files = [
      resolve(import.meta.dirname, "native-runtime-service.ts"),
      ...await readdir(resolve(import.meta.dirname, "../../native-runtime/src/agent-runtime"), { recursive: true })
        .then((entries) => entries
          .filter((entry) => typeof entry === "string" && /(?:runtime-adapter|native-runtime-broker|unified-session-service)\.ts$/.test(entry))
          .map((entry) => resolve(import.meta.dirname, "../../native-runtime/src/agent-runtime", entry))),
    ];
    const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
    expect(contents.join("\n")).not.toContain("@agent/computer-use");
  });
});
