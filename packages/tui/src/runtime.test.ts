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
  async addMessage(id: string, message: Session["messages"][number]) {
    const session = await this.get(id);
    if (session) session.messages.push(message);
  }
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

  it("persists user and assistant messages for the next queued run context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-runtime-"));
    const sessions = new MemorySessions();
    const agent: IAgentLoop = {
      async *run(input): AsyncIterable<AgentEvent> {
        yield { type: "text_chunk", text: `answer:${input}` };
        yield { type: "done", finalText: `answer:${input}` };
      },
      abort() {},
    };
    const runtime = new TuiRuntime(root, baseModel, path.join(root, "store"), sessions, async () => ({ agent, skills: [] }));
    await runtime.initialize();

    await runtime.run("first", () => {});
    await runtime.run("second", () => {});

    expect(sessions.sessions[0]?.messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      "user:first",
      "assistant:answer:first",
      "user:second",
      "assistant:answer:second",
    ]);
  });

  it("persists steer input for the active AgentLoop iteration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-runtime-"));
    const sessions = new MemorySessions();
    const agent: IAgentLoop = { async *run() {}, abort() {} };
    const runtime = new TuiRuntime(root, baseModel, path.join(root, "store"), sessions, async () => ({ agent, skills: [] }));
    await runtime.initialize();

    await runtime.steer("use this now");

    expect(sessions.sessions[0]?.messages).toEqual([{
      role: "user",
      content: "use this now",
      name: "__steer__",
    }]);
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

  it("builds the default agent with a permission gate and safe host defaults", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-runtime-"));
    const runtime = new TuiRuntime(root, baseModel, path.join(root, "store"), new MemorySessions());
    expect(runtime.resolvePermissionMode()).toBe("auto-approval");
    await expect(runtime.requestApproval({
      sessionId: "s",
      toolName: "bash",
      summary: "运行命令：pwd",
      reason: "测试",
      resourceKey: "bash:pwd",
      args: {},
    })).resolves.toBe("deny");

    runtime.setPermissionMode("full-access");
    expect(runtime.resolvePermissionMode()).toBe("full-access");
    // Uses the real default factory: proves the gate wiring builds a working agent.
    await runtime.initialize();
    expect(runtime.snapshot().sessionId).toBeTruthy();
  });

  it("names a new session after its first user message", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-runtime-"));
    const sessions = new MemorySessions();
    const agent: IAgentLoop = {
      async *run(): AsyncIterable<AgentEvent> { yield { type: "done", finalText: "ok" }; },
      abort() {},
    };
    const runtime = new TuiRuntime(root, baseModel, path.join(root, "store"), sessions, async () => ({ agent, skills: [] }));
    await runtime.initialize();
    await runtime.run("帮我修复登录问题\n第二行", () => {});
    expect(sessions.sessions[0]?.title).toBe("帮我修复登录问题");

    // The title is decided once; later turns never rename the session.
    await runtime.run("another question", () => {});
    expect(sessions.sessions[0]?.title).toBe("帮我修复登录问题");
  });

  it("replays persisted user and assistant turns for session restore", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tui-runtime-"));
    const agent: IAgentLoop = {
      async *run(): AsyncIterable<AgentEvent> { yield { type: "done", finalText: "final answer" }; },
      abort() {},
    };
    // Real FileSystemSessionStore: replay reads sessions back from disk.
    const runtime = new TuiRuntime(root, baseModel, path.join(root, "store"), undefined, async () => ({ agent, skills: [] }));
    await runtime.initialize();
    await runtime.run("first question", () => {});

    const messages = await runtime.loadSessionTranscript(runtime.snapshot().sessionId);
    expect(messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "final answer" },
    ]);
    await expect(runtime.loadSessionTranscript("no-such-id")).rejects.toThrow("找不到会话");
  });
});
