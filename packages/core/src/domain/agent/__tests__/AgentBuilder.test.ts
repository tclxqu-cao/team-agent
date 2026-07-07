import { describe, expect, it } from "vitest";
import { AgentBuilder } from "../AgentBuilder.js";
import type { IModelProvider, Message, StreamEvent } from "../../model/entities.js";
import type { RemoteToolDefinition, RemoteToolJob, RemoteToolRegistration } from "../../remote-tools/entities.js";
import type { RemoteToolStore } from "../../remote-tools/RemoteToolStore.js";

class CapturingModelProvider implements IModelProvider {
  readonly providerId = "test";
  readonly modelId = "test-model";
  messages: Message[] = [];

  async *streamChat(messages: Message[]): AsyncIterable<StreamEvent> {
    this.messages = messages;
    yield { type: "text_done" };
  }

  async countTokens(): Promise<number> { return 1; }
  supportsModel(): boolean { return true; }
}

class MemoryRemoteToolStore implements RemoteToolStore {
  private tools = new Map<string, RemoteToolDefinition>();
  private jobs = new Map<string, RemoteToolJob>();

  upsertTools(projectId: string, tools: RemoteToolRegistration[]): RemoteToolDefinition[] {
    return tools.map((tool) => {
      const definition = {
        id: `${projectId}:${tool.scheme}`,
        projectId,
        scheme: tool.scheme,
        purpose: tool.purpose,
        url: tool.url,
        method: "POST" as const,
        headers: tool.headers ?? {},
        inputSchema: tool.inputSchema ?? {},
        outputSchema: tool.outputSchema ?? {},
        examples: tool.examples ?? [],
        auth: tool.auth ?? {},
        enabled: true,
        createdAt: "now",
        updatedAt: "now",
      };
      this.tools.set(definition.id, definition);
      return definition;
    });
  }

  listEnabledTools(projectId: string): RemoteToolDefinition[] {
    return [...this.tools.values()].filter((tool) => tool.projectId === projectId && tool.enabled);
  }

  getTool(projectId: string, scheme: string): RemoteToolDefinition | null {
    return this.tools.get(`${projectId}:${scheme}`) ?? null;
  }

  createJob(projectId: string, scheme: string, requestPayload: Record<string, unknown>): RemoteToolJob {
    const job = { id: `job-${this.jobs.size + 1}`, projectId, scheme, requestPayload, status: "queued" as const, responsePayload: null, error: null, createdAt: "now", updatedAt: "now" };
    this.jobs.set(job.id, job);
    return job;
  }

  markJobRunning(id: string): void { this.jobs.set(id, { ...this.jobs.get(id)!, status: "running" }); }
  markJobSucceeded(id: string, responsePayload: Record<string, unknown>): void { this.jobs.set(id, { ...this.jobs.get(id)!, status: "succeeded", responsePayload }); }
  markJobFailed(id: string, error: string): void { this.jobs.set(id, { ...this.jobs.get(id)!, status: "failed", error }); }
  getJob(id: string): RemoteToolJob | null { return this.jobs.get(id) ?? null; }
}

describe("AgentBuilder", () => {
  it("snapshots projectId for async build before later builder reconfiguration", async () => {
    const store = new MemoryRemoteToolStore();
    store.upsertTools("project-a", [{ scheme: "create_project_a_course", purpose: "项目 A 创建课程", url: "http://project-a/api", method: "POST" }]);
    store.upsertTools("project-b", [{ scheme: "create_project_b_course", purpose: "项目 B 创建课程", url: "http://project-b/api", method: "POST" }]);
    const provider = new CapturingModelProvider();
    const builder = new AgentBuilder().withModelProvider(provider).withRemoteToolStore(store, "project-a");

    const agentPromise = builder.build();
    builder.withRemoteToolStore(store, "project-b");
    const agent = await agentPromise;

    const config = (agent as unknown as { config: { systemPrompt?: string } }).config;
    expect(config.systemPrompt).toContain("create_project_a_course");
    expect(config.systemPrompt).not.toContain("create_project_b_course");
  });
});
