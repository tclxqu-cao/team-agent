import { AgentBuilder, type IModelProvider, type Message, type StreamEvent, type StreamOptions } from "@agent/core";
import { describe, expect, it } from "vitest";
import { agentHost } from "./agent-host";
import { POST as registerRemoteTools } from "./remote-tools/register/route";

class CapturingModelProvider implements IModelProvider {
  readonly providerId = "test";
  readonly modelId = "test-model";
  messages: Message[] = [];
  options: StreamOptions | undefined;

  async *streamChat(messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent> {
    this.messages = messages;
    this.options = options;
    yield { type: "text_done" };
  }

  async countTokens(): Promise<number> { return 1; }
  supportsModel(): boolean { return true; }
}

const kidEarthTool = {
  scheme: "create_kid_earth_course",
  purpose: "创建课程",
  url: "http://kid/api/agent-actions/create-course",
  method: "POST" as const,
};

describe("agentHost singleton", () => {
  it("stores the shared AgentHost on globalThis so answer routes can see pending questions from run routes", () => {
    expect((globalThis as unknown as { __agentHost?: unknown }).__agentHost).toBe(agentHost);
  });

  it("registers remote tools through the server route and exposes them through the runtime builder", async () => {
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
    const agent = await agentHost.getBuilder().build();
    for await (const event of agent.run("生成课程", session.id)) {
      if (event.type === "done") break;
    }

    const remoteToolDefinition = provider.options?.tools?.find((tool) => tool.name === "remote_project_action");
    expect(remoteToolDefinition?.description).toContain("create_kid_earth_course");
    expect(provider.messages.find((message) => message.role === "system")?.content).toContain("create_kid_earth_course");
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

  it("reapplies the remote tool store and current project id when replacing the builder", async () => {
    agentHost.registerRemoteTools("kid-earth-learning", [kidEarthTool]);
    const provider = new CapturingModelProvider();
    agentHost.setBuilder(new AgentBuilder().withModelProvider(provider));

    const session = await agentHost.createSession("set builder remote tools test", "kid-earth-learning");
    const agent = await agentHost.getBuilder().build();
    for await (const event of agent.run("生成课程", session.id)) {
      if (event.type === "done") break;
    }

    const remoteToolDefinition = provider.options?.tools?.find((tool) => tool.name === "remote_project_action");
    expect(remoteToolDefinition?.description).toContain("create_kid_earth_course");
  });
});
