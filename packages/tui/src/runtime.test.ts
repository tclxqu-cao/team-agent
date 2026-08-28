import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent, IAgentLoop, ISessionStore, Session } from "@agent/core";
import type { ModelSelection } from "./model-config.js";
import { TuiRuntime } from "./runtime.js";

class MemorySessions implements ISessionStore {
  sessions: Session[] = [];
  async create(session: Session) { this.sessions.push(session); return session; }
  async get(id: string) { return this.sessions.find((session) => session.id === id) ?? null; }
  async update(id: string, update: Partial<Session>) { const session = (await this.get(id))!; Object.assign(session, update); return session; }
  async delete(id: string) { this.sessions = this.sessions.filter((session) => session.id !== id); }
  async list() { return this.sessions; }
  async listChildren() { return []; }
  async addMessage() {}
  async addEvent() {}
  async replaceMessages() {}
}

const baseModel: ModelSelection = {
  source: "env",
  name: "base",
  provider: "openai",
  modelId: "gpt-test",
  apiKey: "test",
};

describe("TuiRuntime", () => {
  it("emits preparing before agent events and exposes discovered skills", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-runtime-"));
    const agent: IAgentLoop = {
      async *run(): AsyncIterable<AgentEvent> { yield { type: "text_chunk", text: "ok" }; yield { type: "done", finalText: "ok" }; },
      abort() {},
    };
    const runtime = new TuiRuntime(root, baseModel, path.join(root, "store"), new MemorySessions(), async () => ({
      agent,
      skills: [{ name: "test-skill", description: "test", triggers: [], filePath: "/skill", source: "custom" }],
    }));
    const snapshot = await runtime.initialize();
    const events: AgentEvent[] = [];
    await runtime.run("hello", (event) => events.push(event));
    expect(snapshot.skills[0]?.name).toBe("test-skill");
    expect(events.map((event) => event.type)).toEqual(["thinking", "text_chunk", "done"]);
  });

  it("keeps the previous model when replacement construction fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-runtime-"));
    const agent: IAgentLoop = { async *run() {}, abort() {} };
    const runtime = new TuiRuntime(root, baseModel, path.join(root, "store"), new MemorySessions(), async (_cwd, model) => {
      if (model.modelId === "broken") throw new Error("build failed");
      return { agent, skills: [] };
    });
    await runtime.initialize();
    await expect(runtime.switchModel({ ...baseModel, modelId: "broken" })).rejects.toThrow("build failed");
    expect(runtime.snapshot().model.modelId).toBe("gpt-test");
  });
});
