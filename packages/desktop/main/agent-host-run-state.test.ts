import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBuilder, type IModelProvider, type Message, type StreamEvent } from "@agent/core";
import { describe, expect, it } from "vitest";
import * as agentHostModule from "./agent-host";

const shouldInterruptPreviousRun = (agentHostModule as unknown as {
  shouldInterruptPreviousRun?: (runCountIncludingCurrent: number) => boolean;
}).shouldInterruptPreviousRun;

describe("shouldInterruptPreviousRun", () => {
  it("does not interrupt the first IPC run counted as active", () => {
    expect(typeof shouldInterruptPreviousRun).toBe("function");
    expect(shouldInterruptPreviousRun?.(1)).toBe(false);
  });

  it("interrupts when another IPC run was already active", () => {
    expect(shouldInterruptPreviousRun?.(2)).toBe(true);
  });
});

class CompletingModelProvider implements IModelProvider {
  readonly providerId = "test";
  readonly modelId = "test";

  async *streamChat(_messages: Message[]): AsyncIterable<StreamEvent> {
    yield { type: "text_done" };
  }

  async countTokens(): Promise<number> { return 1; }
  supportsModel(): boolean { return true; }
}

describe("AgentHost session titles", () => {
  it("consumes a new placeholder marker once without renaming historical placeholders", async () => {
    const path = await mkdtemp(join(tmpdir(), "agentroam-desktop-title-"));
    const host = new agentHostModule.AgentHost(path);
    host.getBuilder()
      .withModelProvider(new CompletingModelProvider())
      .withSemanticSkillMatching(false);

    try {
      const session = await host.createSession("新会话");
      expect(session.metadata.autoTitleFromFirstMessage).toBe(true);
      for await (const _event of host.run("第一条消息", session.id)) { /* exhaust run */ }
      for await (const _event of host.run("后续消息", session.id)) { /* exhaust run */ }
      await expect(host.getSessionStore().get(session.id)).resolves.toMatchObject({
        title: "第一条消息",
        metadata: { permissionMode: "full-access" },
      });

      const now = new Date().toISOString();
      const historicalId = crypto.randomUUID();
      await host.getSessionStore().create({
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
      for await (const _event of host.run("不能回填历史会话", historicalId)) { /* exhaust run */ }
      await expect(host.getSessionStore().get(historicalId)).resolves.toMatchObject({ title: "新会话" });
    } finally {
      (host as unknown as { cronScheduler: { stop(): void } }).cronScheduler.stop();
      await rm(path, { recursive: true, force: true });
    }
  });

  it("does not mark an explicitly titled session", async () => {
    const path = await mkdtemp(join(tmpdir(), "agentroam-desktop-title-"));
    const host = new agentHostModule.AgentHost(path);
    try {
      const session = await host.createSession("显式标题");
      expect(session.metadata).toEqual({ permissionMode: "full-access" });
    } finally {
      (host as unknown as { cronScheduler: { stop(): void } }).cronScheduler.stop();
      await rm(path, { recursive: true, force: true });
    }
  });
});
