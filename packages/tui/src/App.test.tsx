import React from "react";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { TuiApp } from "./App.js";
import type { AgentEvent, AskUserRequest, AskUserResponse } from "@agent/core";
import type { TuiRuntime } from "./runtime.js";

afterEach(() => cleanup());

async function tick(milliseconds = 50) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fixture(options: {
  run?: (input: string, onEvent: (event: AgentEvent) => void) => Promise<void>;
  sessions?: Array<{ id: string; title: string; created: string }>;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tui-app-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.ts"), "export {};");
  const snapshot = {
    workingDirectory: root,
    sessionId: "session-one",
    model: { source: "env" as const, name: "Test", provider: "openai", modelId: "gpt-test", apiKey: "test" },
    skills: [{ name: "wiki-query", description: "Search wiki", triggers: [], filePath: "/skill", source: "custom" as const }],
  };
  let questionHandler: ((request: AskUserRequest) => Promise<AskUserResponse>) | undefined;
  const openedSessions: string[] = [];
  const switchedModels: string[] = [];
  const runtime = {
    snapshot: () => snapshot,
    setQuestionHandler: (handler: (request: AskUserRequest) => Promise<AskUserResponse>) => { questionHandler = handler; },
    listSessions: async () => options.sessions ?? [],
    newSession: async () => "session-two",
    openSession: async (id: string) => { openedSessions.push(id); return id; },
    run: options.run ?? (async () => {}),
    abort: () => {},
    switchModel: async (model: { modelId: string }) => { switchedModels.push(model.modelId); return { ...snapshot, model: { ...snapshot.model, ...model } }; },
    switchProject: async () => snapshot,
  } as unknown as TuiRuntime;
  return { root, snapshot, runtime, openedSessions, switchedModels, getQuestionHandler: () => questionHandler };
}

describe("TuiApp palettes", () => {
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
    await tick();
    expect(view.lastFrame()).toContain("文件");
    expect(view.lastFrame()).toContain("src/main.ts");
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

  it("renders streamed thinking, tools, and text in event order", async () => {
    const { snapshot, runtime } = await fixture({
      run: async (_input, onEvent) => {
        onEvent({ type: "thinking", message: "Iteration 1..." });
        onEvent({ type: "tool_call", toolCall: { id: "call", name: "bash", arguments: { command: "pwd" } } });
        onEvent({ type: "tool_result", result: { toolCallId: "call", content: "/tmp/project" } });
        onEvent({ type: "text_chunk", text: "done" });
        onEvent({ type: "done", finalText: "done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      },
    });
    const view = render(<TuiApp runtime={runtime} initialSnapshot={snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();
    view.stdin.write("run pwd");
    await tick();
    view.stdin.write("\r");
    await tick();
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("TOOL    bash");
    expect(frame).toContain("/tmp/project");
    expect(frame).toContain("AGENT   done");
    expect(frame).toContain("✓ 完成");
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
    expect(view.lastFrame()).toContain("1/11");
    expect(view.lastFrame()).toContain("› /help");

    view.stdin.write("\u001b[B");
    await tick();
    expect(view.lastFrame()).toContain("2/11");
    expect(view.lastFrame()).toContain("› /new");

    view.stdin.write("\u001bOB");
    await tick();
    expect(view.lastFrame()).toContain("3/11");
    expect(view.lastFrame()).toContain("› /sessions");

    view.stdin.write("\u001bOA");
    await tick();
    expect(view.lastFrame()).toContain("2/11");

    view.stdin.write("\u001b");
    view.stdin.write("[B");
    await tick();
    expect(view.lastFrame()).toContain("3/11");
    expect(view.lastFrame()).toContain("› /sessions");

    view.stdin.write("\r");
    await tick();
    expect(view.lastFrame()).not.toContain("↑↓ 移动");
    expect(view.lastFrame()).toContain("› /sessions");
  });

  it("handles batched terminal input and exits palette mode with backspace", async () => {
    const { snapshot, runtime } = await fixture();
    const view = render(<TuiApp runtime={runtime} initialSnapshot={snapshot} profiles={[]} registeredProjects={[]} configPath="/tmp/tui-config" env={{}} />);
    await tick();

    view.stdin.write("/\u001b[B");
    await tick();
    expect(view.lastFrame()).toContain("2/11");
    expect(view.lastFrame()).toContain("› /new");
    expect(view.lastFrame()).toContain("⌕ /");

    view.stdin.write("\u007f");
    await tick();
    expect(view.lastFrame()).not.toContain("↑↓ 移动");
    expect(view.lastFrame()).not.toContain("⌕ /");
    expect(view.lastFrame()).toContain("/ 命令  @ 引用");
  });
});
