import { describe, expect, it } from "vitest";
import { toolActivityLabel, toolActivityPreview, toolFamily, toolPhrase, toolPreview } from "./tool-call-presentation";

describe("Codex subagent tool presentation", () => {
  it.each([
    ["started", "开始工作"],
    ["interacted", "已交互"],
    ["completed", "已完成"],
    ["interrupted", "已中断"],
  ])("shows the agent name and %s activity state", (kind, state) => {
    const args = { kind, agentThreadId: "child-thread", agentPath: "/root/question_card_ui" };
    expect(toolPreview("codex:subagentActivity", args)).toBe(`question_card_ui · ${state}`);
    expect(toolActivityPreview("codex:subagentActivity", args)).toBe(`question_card_ui · ${state}`);
    expect(toolActivityLabel("codex:subagentActivity")).toBe("子任务");
    expect(toolFamily("codex:subagentActivity")).toBe("generic");
  });

  it.each([
    ["spawnAgent", "启动了子任务"],
    ["sendInput", "向子任务发送了消息"],
    ["resumeAgent", "恢复了子任务"],
    ["closeAgent", "停止了子任务"],
    ["wait", "等待了子任务"],
    ["sendMessage", "向子任务发送了消息"],
    ["followupTask", "追加了子任务"],
    ["interruptAgent", "停止了子任务"],
    ["listAgents", "查看了子任务"],
  ])("labels %s as a child task operation", (tool, done) => {
    expect(toolActivityLabel(`codex:${tool}`)).toBe("子任务");
    expect(toolPhrase(`codex:${tool}`)?.done).toBe(done);
    expect(toolPreview(`codex:${tool}`, { prompt: "核对原始消息\n保留现有改动" })).toBe("核对原始消息");
  });

  it("keeps incomplete activity metadata readable without exposing an undefined value", () => {
    expect(toolPreview("codex:subagentActivity", { kind: "completed" })).toBe("已完成");
    expect(toolPreview("codex:subagentActivity", { agentPath: "/root/research", kind: "unknown" })).toBe("research");
    expect(toolPreview("codex:subagentActivity", {})).toBeNull();
    expect(toolPreview("codex:wait", { receiverThreadIds: ["child-thread"] })).toBeNull();
  });

  it("preserves the existing display for other namespaced tools", () => {
    expect(toolActivityLabel("codex:unknownTool")).toBe("工具");
    expect(toolPreview("codex:unknownTool", {})).toBe("unknownTool");
  });
});
