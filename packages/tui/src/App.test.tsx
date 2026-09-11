import React from "react";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { TuiApp } from "./App.js";
import type { AgentEvent, AskUserRequest, AskUserResponse, ToolApprovalDecision, ToolPermissionMode, ToolPermissionRequest } from "@agent/core";
import type { TuiRuntime } from "./runtime.js";

afterEach(() => cleanup());

async function tick(milliseconds = 50) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFrame(view: { lastFrame(): string | undefined }, text: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!view.lastFrame()?.includes(text) && Date.now() < deadline) await tick(20);
}

async function fixture(options: {
  run?: (input: string, onEvent: (event: AgentEvent) => void) => Promise<void>;
  sessions?: Array<{ id: string; title: string; created: string }>;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
} = {}) {
  const fixtureParent = await mkdtemp(path.join(os.tmpdir(), "tui-app-parent-"));
  const root = path.join(fixtureParent, "current");
  await mkdir(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.ts"), "export {};");
  const snapshot = {
    workingDirectory: root,
    sessionId: "session-one",
    model: { source: "env" as const, name: "Test", provider: "openai", modelId: "gpt-test", apiKey: "test" },
    skills: [{ name: "wiki-query", description: "Search wiki", triggers: [], filePath: "/skill", source: "custom" as const }],
  };
  let questionHandler: ((request: AskUserRequest) => Promise<AskUserResponse>) | undefined;
  let approvalHandler: ((request: ToolPermissionRequest) => Promise<ToolApprovalDecision>) | undefined;
  const permissionModes: ToolPermissionMode[] = [];
  const openedSessions: string[] = [];
  const switchedModels: string[] = [];
  const steeredInputs: string[] = [];
  const switchedProjects: string[] = [];
  const runtime = {
    snapshot: () => snapshot,
    setQuestionHandler: (handler: (request: AskUserRequest) => Promise<AskUserResponse>) => { questionHandler = handler; },
    setApprovalHandler: (handler: (request: ToolPermissionRequest) => Promise<ToolApprovalDecision>) => { approvalHandler = handler; },
    setPermissionMode: (mode: ToolPermissionMode) => { permissionModes.push(mode); },
    setDispatchReporter: () => {},
    setMcpServers: () => {},
    getMcpStatuses: () => [],
    compactSession: async () => null,
    journal: { undoLastBatch: async () => null, beginBatch: () => {}, snapshot: async () => {}, batchCount: () => 0 },
    loadSessionTranscript: async () => options.messages ?? [],
    listSessions: async () => options.sessions ?? [],
    newSession: async () => "session-two",
    openSession: async (id: string) => { openedSessions.push(id); return id; },
    run: options.run ?? (async () => {}),
    abort: () => {},
    steer: async (input: string) => { steeredInputs.push(input); },
    switchModel: async (model: { modelId: string }) => { switchedModels.push(model.modelId); return { ...snapshot, model: { ...snapshot.model, ...model } }; },
    switchProject: async (directory: string) => {
      switchedProjects.push(directory);
      return { ...snapshot, workingDirectory: directory, sessionId: "project-session" };
    },
  } as unknown as TuiRuntime;
  return { root, snapshot, runtime, openedSessions, switchedModels, steeredInputs, switchedProjects, permissionModes, getQuestionHandler: () => questionHandler, getApprovalHandler: () => approvalHandler };
}

describe("TuiApp palettes", () => {
  it("accepts messages while running and drains them in FIFO order", async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const inputs: string[] = [];
    const { snapshot, runtime } = await fixture({
      run: async (input, onEvent) => {
        inputs.push(input);
        onEvent({ type: "thinking", message: "Iteration 1..." });
        if (input === "first") await firstPending;
        onEvent({ type: "done", finalText: `done:${input}` });
      },
    });
    const view = render(<TuiApp runtime={runtime} initialSnapshot={snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();

    view.stdin.write("first");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("排队发送消息");

    view.stdin.write("second");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(inputs).toEqual(["first"]);
    expect(view.lastFrame()).toContain("≡");
    expect(view.lastFrame()).toContain("second");

    releaseFirst();
    await tick(120);
    expect(inputs).toEqual(["first", "second"]);
    expect(view.lastFrame()).not.toContain("≡");
  });

  it("steers a selected queued message into the active turn", async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const current = await fixture({
      run: async (input, onEvent) => {
        onEvent({ type: "thinking", message: "Iteration 1..." });
        if (input === "first") await firstPending;
        onEvent({ type: "done", finalText: `done:${input}` });
      },
    });
    const view = render(<TuiApp runtime={current.runtime} initialSnapshot={current.snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();

    for (const message of ["first", "use now", "keep queued"]) {
      view.stdin.write(message);
      await tick();
      view.stdin.write("\r");
      await tick();
    }
    expect(view.lastFrame()).toContain("/steer 1 插入当前轮");

    view.stdin.write("/steer 1");
    await tick();
    view.stdin.write("\r");
    await tick(100);
    expect(current.steeredInputs).toEqual(["use now"]);
    expect(view.lastFrame()).toContain("keep queued");
    expect(view.lastFrame()).not.toContain("1. use now");

    releaseFirst();
    await tick(120);
  });

  it("rejects steer outside an active turn", async () => {
    const current = await fixture();
    const view = render(<TuiApp runtime={current.runtime} initialSnapshot={current.snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();

    view.stdin.write("/steer 1");
    await tick();
    view.stdin.write("\r");
    await tick();

    expect(current.steeredInputs).toEqual([]);
    expect(view.lastFrame()).toContain("/steer 只能在 Agent 运行时使用");
  });

  it("preserves queued messages when steer is invalid or rejected", async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const current = await fixture({
      run: async (_input, onEvent) => {
        onEvent({ type: "thinking", message: "Iteration 1..." });
        await firstPending;
        onEvent({ type: "done", finalText: "done" });
      },
    });
    const runtime = current.runtime as unknown as { steer: (input: string) => Promise<void> };
    runtime.steer = async () => { throw new Error("session write failed"); };
    const view = render(<TuiApp runtime={current.runtime} initialSnapshot={current.snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();

    for (const message of ["first", "keep queued"]) {
      view.stdin.write(message);
      await tick();
      view.stdin.write("\r");
      await tick();
    }

    view.stdin.write("/steer 2");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("当前有 1 条排队消息");
    expect(view.lastFrame()).toContain("1. keep queued");

    view.stdin.write("/steer 1");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("插入当前轮失败，消息仍在队列: session write failed");
    expect(view.lastFrame()).toContain("1. keep queued");

    releaseFirst();
    await tick(120);
  });

  it("opens commands and discovered skills when slash is typed", async () => {
    const { snapshot, runtime } = await fixture();
    const view = render(<TuiApp runtime={runtime} initialSnapshot={snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();
    view.stdin.write("/");
    await tick();
    expect(view.lastFrame()).toContain("命令与技能");
    expect(view.lastFrame()).toContain("命令");
    expect(view.lastFrame()).toContain("技能");
    expect(view.lastFrame()).toContain("/wiki-query");
    expect(view.lastFrame()).toContain("筛选");
    expect(view.lastFrame()).toContain("⌕ /");
    view.stdin.write("\u001b");
    await tick(120);
    expect(view.lastFrame()).not.toContain("↑↓ 移动");
    expect(view.lastFrame()).not.toContain("⌕ /");
  });

  it("filters at-mentions to project files", async () => {
    const { snapshot, runtime } = await fixture();
    const view = render(<TuiApp runtime={runtime} initialSnapshot={snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();
    view.stdin.write("@main.ts");
    await waitForFrame(view, "src/main.ts");
    expect(view.lastFrame()).toContain("文件");
    expect(view.lastFrame()).toContain("src/main.ts");
  });

  it("switches projects locally for a natural-language navigation request", async () => {
    const current = await fixture();
    const refundRoot = await mkdtemp(path.join(os.tmpdir(), "tui-refund-project-"));
    const view = render(
      <TuiApp
        runtime={current.runtime}
        initialSnapshot={current.snapshot}
        profiles={[]}
        registeredProjects={[{ id: "refund", name: "赔付", description: refundRoot }]}
        configPath="/tmp/tui-config"
        env={{}}
      />,
    );
    await tick();

    view.stdin.write("@");
    await waitForFrame(view, "赔付");
    expect(view.lastFrame()).toContain("赔付");
    view.stdin.write("\u007f");
    await tick();

    view.stdin.write("我要进入赔付项目");
    await tick();
    view.stdin.write("\r");
    await tick(120);

    expect(view.lastFrame()).toContain("已切换项目");
    expect(current.switchedProjects).toEqual([await realpath(refundRoot)]);
  });

  it("opens model and session secondary palettes and executes selections", async () => {
    const sessions = [{ id: "history-session", title: "History", created: "2026-08-28T12:00:00Z" }];
    const { root, snapshot, runtime, openedSessions, switchedModels } = await fixture({ sessions });
    const profiles = [{
      id: "profile-two",
      name: "Second",
      provider: "openai",
      modelId: "gpt-second",
      apiKey: "secret",
      sourcePath: "/desktop.db",
    }];
    const view = render(<TuiApp runtime={runtime} initialSnapshot={snapshot} profiles={profiles} registeredProjects={[]} configPath={path.join(root, "config.json")} env={{}} />);
    await tick();
    view.stdin.write("/model");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("模型");
    expect(view.lastFrame()).toContain("Second");
    view.stdin.write("\u001b[B");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(switchedModels).toEqual(["gpt-second"]);

    view.stdin.write("/open");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("会话");
    expect(view.lastFrame()).toContain("History");
    view.stdin.write("\r");
    await tick();
    expect(openedSessions).toEqual(["history-session"]);
  });

  it("configures an OpenAI-compatible service with a masked key and default model", async () => {
    const { root, snapshot, runtime, switchedModels } = await fixture();
    const configPath = path.join(root, "config.json");
    let releaseModels!: () => void;
    const modelsPending = new Promise<void>((resolve) => { releaseModels = resolve; });
    const view = render(
      <TuiApp
        runtime={runtime}
        initialSnapshot={snapshot}
        profiles={[]}
        registeredProjects={[]}
        configPath={configPath}
        env={{}}
        modelFetcher={async () => {
          await modelsPending;
          return {
            endpoint: {
              name: "models.example.com",
              baseUrl: "https://models.example.com",
              modelsUrl: "https://models.example.com/v1/models",
            },
            models: ["gpt-one", "gpt-two"],
          };
        }}
      />,
    );
    await tick();

    view.stdin.write("/model");
    await tick();
    view.stdin.write("\r");
    await tick();
    view.stdin.write("\u001b[B");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("服务地址");

    view.stdin.write("https://models.example.com/v1");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("API Key");

    view.stdin.write("saved-secret");
    await tick();
    expect(view.lastFrame()).not.toContain("saved-secret");
    expect(view.lastFrame()).toContain("••••••••••••");
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("正在获取模型");
    expect(view.lastFrame()).not.toContain("saved-secret");
    releaseModels();
    await tick(100);
    expect(view.lastFrame()).toContain("选择默认模型");
    expect(view.lastFrame()).toContain("gpt-one");

    view.stdin.write("\u001b[B");
    await tick();
    view.stdin.write("\r");
    await tick(100);
    expect(switchedModels).toEqual(["gpt-two"]);
    const saved = await readFile(configPath, "utf8");
    expect(saved).toContain("saved-secret");
    expect(saved).toContain('"defaultModelId": "gpt-two"');
  });

  it("renders streamed thinking, tools, and text in event order", async () => {
    const { snapshot, runtime } = await fixture({
      run: async (_input, onEvent) => {
        onEvent({ type: "thinking", message: "Iteration 1..." });
        onEvent({ type: "tool_call", toolCall: { id: "call", name: "bash", arguments: { command: "pwd" } } });
        onEvent({ type: "tool_result", result: { toolCallId: "call", content: "/tmp/project" } });
        onEvent({ type: "text_chunk", text: "**done** with `code`" });
        onEvent({ type: "done", finalText: "done with code", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      },
    });
    const view = render(<TuiApp runtime={runtime} initialSnapshot={snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();
    view.stdin.write("run pwd");
    await tick();
    view.stdin.write("\r");
    await tick();
    const frame = view.lastFrame() ?? "";
    expect(frame).toMatch(/⚙\s+│ bash/);
    expect(frame).toContain("/tmp/project");
    expect(frame).toMatch(/◆\s+│ done with code/);
    expect(frame).toMatch(/✓\s+│ 完成/);
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("`code`");
  });

  it("routes inline question answers back to the runtime", async () => {
    let answer = "";
    const current = await fixture();
    const runtime = current.runtime as unknown as {
      run: (input: string, onEvent: (event: AgentEvent) => void) => Promise<void>;
    };
    runtime.run = async () => {
      const handler = current.getQuestionHandler();
      if (!handler) throw new Error("question handler missing");
      answer = (await handler({ toolCallId: "ask-one", question: "Choose", options: [
        { label: "Alpha", description: "first" },
        { label: "Beta", description: "second" },
      ] })).answer;
    };
    const view = render(<TuiApp runtime={current.runtime} initialSnapshot={current.snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();
    view.stdin.write("ask");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("Choose");
    view.stdin.write("2");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(answer).toBe("Beta");
  });

  it("moves slash selection with CSI, SS3, and fragmented cursor sequences", async () => {
    const { snapshot, runtime } = await fixture();
    const view = render(<TuiApp runtime={runtime} initialSnapshot={snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();
    view.stdin.write("/");
    await tick();
    expect(view.lastFrame()).toContain("1/21");
    expect(view.lastFrame()).toContain("› /help");

    view.stdin.write("\u001b[B");
    await tick();
    expect(view.lastFrame()).toContain("2/21");
    expect(view.lastFrame()).toContain("› /new");

    view.stdin.write("\u001bOB");
    await tick();
    expect(view.lastFrame()).toContain("3/21");
    expect(view.lastFrame()).toContain("› /sessions");

    view.stdin.write("\u001bOA");
    await tick();
    expect(view.lastFrame()).toContain("2/21");

    view.stdin.write("\u001b");
    view.stdin.write("[B");
    await tick();
    expect(view.lastFrame()).toContain("3/21");
    expect(view.lastFrame()).toContain("› /sessions");

    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).not.toContain("↑↓ 移动");
    // Enter on /sessions executes the command (which appends a notice listing
    // sessions, or "还没有会话" when there are none). The slash palette itself
    // closes because setInput("") clears the trigger, so we assert on the
    // command's side-effect rather than the now-closed palette.
    expect(view.lastFrame()).toContain("还没有会话");
  });

  it("handles batched terminal input and exits palette mode with backspace", async () => {
    const { snapshot, runtime } = await fixture();
    const view = render(<TuiApp runtime={runtime} initialSnapshot={snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();

    view.stdin.write("/\u001b[B");
    await tick();
    expect(view.lastFrame()).toContain("2/21");
    expect(view.lastFrame()).toContain("› /new");
    expect(view.lastFrame()).toContain("⌕ /");

    view.stdin.write("\u007f");
    await tick();
    expect(view.lastFrame()).not.toContain("↑↓ 移动");
    expect(view.lastFrame()).not.toContain("⌕ /");
    expect(view.lastFrame()).toContain("/ 命令  @ 引用");
  });

  it("routes tool approval decisions through the runtime approval handler", async () => {
    let decision: ToolApprovalDecision | undefined;
    const current = await fixture();
    const runtime = current.runtime as unknown as {
      run: (input: string, onEvent: (event: AgentEvent) => void) => Promise<void>;
    };
    runtime.run = async () => {
      const handler = current.getApprovalHandler();
      if (!handler) throw new Error("approval handler missing");
      decision = await handler({
        sessionId: "session-one",
        toolName: "bash",
        summary: "运行命令：pwd",
        reason: "命令将在当前工作区的终端中运行",
        resourceKey: "bash:pwd",
        args: { command: "pwd" },
      });
    };
    const view = render(<TuiApp runtime={current.runtime} initialSnapshot={current.snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();
    view.stdin.write("run pwd");
    await tick();
    view.stdin.write("\r");
    await waitForFrame(view, "工具执行审批");
    expect(view.lastFrame()).toContain("bash");
    expect(view.lastFrame()).toContain("1. 允许一次");
    expect(view.lastFrame()).toContain("输入 1-4 选择");

    view.stdin.write("2");
    await tick();
    view.stdin.write("\r");
    await tick(120);
    expect(decision).toBe("allow-session");
  });

  it("switches permission mode from the /permissions palette", async () => {
    const current = await fixture();
    const view = render(<TuiApp runtime={current.runtime} initialSnapshot={current.snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();
    view.stdin.write("/permissions");
    await tick();
    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).toContain("审批模式");
    expect(view.lastFrame()).toContain("仅高风险询问");
    expect(view.lastFrame()).toContain("当前 ·");

    // First row is the first enabled non-current mode (enabled items sort first).
    view.stdin.write("\r");
    await tick(100);
    expect(current.permissionModes.at(-1)).toBe("request-approval");
    expect(view.lastFrame()).toContain("工具审批模式：全部询问");
  });

  it("replays persisted messages when a historical session is opened", async () => {
    const sessions = [{ id: "history-session", title: "History", created: "2026-08-28T12:00:00Z" }];
    const current = await fixture({
      sessions,
      messages: [
        { role: "user", content: "上一轮的问题" },
        { role: "assistant", content: "上一轮的回答" },
      ],
    });
    const view = render(<TuiApp runtime={current.runtime} initialSnapshot={current.snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();
    view.stdin.write("/open history");
    await tick();
    view.stdin.write("\r");
    await tick(120);

    expect(current.openedSessions).toEqual(["history"]);
    expect(view.lastFrame()).toContain("重放 2 条历史消息");
    expect(view.lastFrame()).toContain("上一轮的问题");
    expect(view.lastFrame()).toContain("上一轮的回答");
  });

  it("keeps a pasted multi-line chunk as one message and submits on Enter", async () => {
    const inputs: string[] = [];
    const current = await fixture({
      run: async (input) => {
        inputs.push(input);
      },
    });
    const view = render(<TuiApp runtime={current.runtime} initialSnapshot={current.snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();

    view.stdin.write("line1\nline2");
    await tick();
    expect(view.lastFrame()).toContain("line1");
    expect(view.lastFrame()).toContain("line2");

    view.stdin.write("\r");
    await tick(120);
    expect(inputs).toEqual(["line1\nline2"]);
    expect(view.lastFrame()).toContain("line1");
    expect(view.lastFrame()).toContain("line2");
  });

  it("removes a queued message with /unqueue", async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const inputs: string[] = [];
    const current = await fixture({
      run: async (input, onEvent) => {
        inputs.push(input);
        onEvent({ type: "thinking", message: "Iteration 1..." });
        if (input === "first") await firstPending;
        onEvent({ type: "done", finalText: `done:${input}` });
      },
    });
    const view = render(<TuiApp runtime={current.runtime} initialSnapshot={current.snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();

    for (const message of ["first", "keep", "drop me"]) {
      view.stdin.write(message);
      await tick();
      view.stdin.write("\r");
      await tick();
    }
    view.stdin.write("/unqueue 2");
    await tick();
    view.stdin.write("\r");
    await tick(100);
    expect(view.lastFrame()).toContain("已移除排队消息 2");
    expect(view.lastFrame()).not.toContain("2. drop me");

    releaseFirst();
    await tick(120);
    expect(inputs).toEqual(["first", "keep"]);
  });
});
