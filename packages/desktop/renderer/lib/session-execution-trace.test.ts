import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import { groupSessionExecutionMessages, sessionExecutionActivity } from "./session-execution-trace";
import { messageActionPolicy } from "./message-actions";

function message(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "assistant", content: "", timestamp: 1, ...extra };
}
const user = (id = "user") => message(id, { role: "user", content: "画出消息发送到完结的流程" });
const reasoning = [{ sectionIndex: 0, text: "整理完整流程" }];
const tool = message("tool", {
  content: "核对发送入口", presentation: { reasoning },
  toolCalls: [{ id: "call", name: "shell", arguments: { command: "rg sendTurn" }, result: "" }],
});
const final = message("final", { content: "流程如下：\n```mermaid\ngraph TD; A-->B\n```", presentation: { reasoning } });

describe("session execution activity ownership", () => {
  it("moves activity to the last visible native segment without highlighting old progress", () => {
    const earlier = message("earlier", { executionTrace: { turnId: "turn", segmentIndex: 0, revision: "r" } });
    const latest = message("latest", { executionTrace: { turnId: "turn", segmentIndex: 1, revision: "r" } });
    expect(sessionExecutionActivity([user(), earlier, user("follow-up"), latest], true))
      .toEqual({ kind: "message", messageId: "latest" });
    expect(sessionExecutionActivity([user(), earlier, user("new")], true)).toEqual({ kind: "pending" });
    expect(sessionExecutionActivity([user(), earlier], false)).toEqual({ kind: "none" });
  });

  it("stops at a pending question or final answer and resumes after new work arrives", () => {
    const question = message("question", { askUser: { questionId: "q", question: "选哪个" } });
    expect(sessionExecutionActivity([user(), tool, question], true)).toEqual({ kind: "none" });
    expect(sessionExecutionActivity([user(), tool, question, tool], true)).toEqual({ kind: "message", messageId: "tool" });
    expect(sessionExecutionActivity([user(), tool, { ...final, presentation: { agentMessagePhase: "final_answer" } }], true))
      .toEqual({ kind: "none" });
    expect(sessionExecutionActivity([user(), message("frozen", { executionTrace: { turnId: "engine-frozen:old", revision: "r" } })], true))
      .toEqual({ kind: "none" });
  });

  it("uses the same ownership rule for shared groups and ignores queued messages", () => {
    const messages = groupSessionExecutionMessages([user(), tool], true);
    expect(sessionExecutionActivity([...messages, { ...user("queued"), isQueued: true }], true))
      .toEqual({ kind: "message", messageId: "session-execution:user:0" });
    expect(sessionExecutionActivity([], true)).toEqual({ kind: "pending" });
  });
});

describe("Session execution display projection", () => {
  it("groups completed progress, tools and final reasoning while preserving the final answer", () => {
    const source = [user(), tool, final];
    const before = JSON.stringify(source);
    const projected = groupSessionExecutionMessages(source, false);
    expect(projected.map(entry => entry.id)).toEqual(["user", "session-execution:user:0", "final"]);
    const group = projected[1].executionGroup!;
    expect(group.isRunning).toBe(false);
    expect(group.messages[0].presentation?.agentMessagePhase).toBe("commentary");
    expect(group.messages[0].toolCalls?.[0].result).toBe("");
    expect(group.messages[1].presentation?.reasoning).toEqual(reasoning);
    expect(group.messages[1].content).toBe("");
    expect(projected[2].content).toBe(final.content);
    expect(projected[2].presentation?.reasoning).toBeUndefined();
    expect(messageActionPolicy(projected, 2, false).showCopy).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("keeps an active turn expanded and collapses only that turn on completion", () => {
    const source = [user("old"), tool, final, user("new"), message("progress", { content: "正在检查" })];
    const active = groupSessionExecutionMessages(source, true);
    const groups = active.flatMap(entry => entry.executionGroup ? [entry.executionGroup] : []);
    expect(groups.map(group => group.isRunning)).toEqual([false, true]);
    expect(groups[1].messages[0].content).toBe("正在检查");
    const completed = groupSessionExecutionMessages([...source, message("new-final", { content: "完成" })], false);
    expect(completed.find(entry => entry.executionGroup?.id === groups[1].id)?.executionGroup?.isRunning).toBe(false);
    expect(completed.at(-1)?.content).toBe("完成");
  });

  it("uses authoritative timing even while the session is admitting the next queued run", () => {
    const projected = groupSessionExecutionMessages([user(), tool, {
      ...final, presentation: { reasoning, completionDurationMs: 65_000 },
    }], true);
    expect(projected[1].executionGroup).toMatchObject({ isRunning: false, durationMs: 65_000 });
    expect(projected.at(-1)?.content).toBe(final.content);
  });

  it("leaves pending questions, widgets and compaction outside the disclosure in order", () => {
    const question = message("question", { askUser: { questionId: "q", question: "选择方案" } });
    const widget = message("widget", { widget: { widgetId: "w", widgetType: "show", data: {} } });
    const compaction = message("compaction", { content: "压缩完成", isCompactionSummary: true });
    const projected = groupSessionExecutionMessages([user(), tool, question, widget, compaction, final], false);
    expect(projected.map(entry => entry.id)).toEqual([
      "user", "session-execution:user:0", "question", "widget", "compaction", "session-execution:user:1", "final",
    ]);
    expect(projected.find(entry => entry.id === "question")).toBe(question);
    expect(projected.flatMap(entry => entry.executionGroup?.messages ?? [])).not.toContain(question);
  });

  it("does not regroup an unanchored page or Codex execution carriers", () => {
    const carrier = message("codex", { executionTrace: { turnId: "original", revision: "rev" } });
    expect(groupSessionExecutionMessages([tool, final], false)).toEqual([tool, final]);
    expect(groupSessionExecutionMessages([user(), carrier], false)).toEqual([user(), carrier]);
  });

  it("folds an explicitly owned native prefix while preserving its final answer and following input", () => {
    const scoped = (entry: ChatMessage) => ({ ...entry, presentation: { ...entry.presentation, executionTrace: { turnId: "native-prefix" } } });
    const source = [scoped(tool), scoped(message("more", { toolCalls: [{ id: "more-call", name: "Read", arguments: {}, result: "text" }] })),
      scoped(final), user("next")];
    const result = groupSessionExecutionMessages(source, false);
    expect(result.map(entry => entry.id)).toEqual(["session-execution:native-prefix:0", "final", "next"]);
    expect(result[0].executionGroup?.messages.flatMap(entry => entry.toolCalls ?? []).map(call => call.id)).toEqual(["call", "more-call"]);
    expect(result[1].content).toBe(final.content);
    expect(result[2]).toBe(source[3]);
    expect(result.filter(entry => entry.role === "user")).toEqual([source[3]]);

    const anchored = groupSessionExecutionMessages([scoped(user("original")), ...source], false);
    expect(anchored[1].executionGroup?.id).toBe(result[0].executionGroup?.id);
  });

  it("folds a complete compacted prefix using its display scope without adding a user bubble", () => {
    const prefix = { ...tool, historyPrefixId: "history-prefix:session:thought" };
    const result = groupSessionExecutionMessages([prefix, final, user("next")], false);
    expect(result[0].executionGroup?.id).toBe("session-execution:history-prefix:session:thought:0");
    expect(result[1].content).toBe(final.content);
    expect(result.filter(entry => entry.role === "user").map(entry => entry.id)).toEqual(["next"]);
    expect(result[0].presentation?.executionTrace).toBeUndefined();
  });

  it("does not add a disclosure to a plain answer with no execution process", () => {
    const answer = message("answer", { content: "你好" });
    expect(groupSessionExecutionMessages([user(), answer], false)).toEqual([user(), answer]);
  });

  it("keeps explicit commentary inside the process instead of treating it as a final answer", () => {
    const commentary = message("progress", { content: "仍在检查", presentation: { agentMessagePhase: "commentary" } });
    const projected = groupSessionExecutionMessages([user(), commentary], false);
    expect(projected).toHaveLength(2);
    expect(projected[1].executionGroup?.messages[0].content).toBe("仍在检查");
  });

  it("preserves steered input anchors and metadata used by final-answer actions", () => {
    const steered = message("steer", { role: "user", content: "补充", isSteered: true });
    const answer = { ...final, presentation: { reasoning, forkPoint: { turnId: "turn" }, completionDurationMs: 0 } };
    const projected = groupSessionExecutionMessages([user(), tool, steered, answer], false);
    expect(projected.find(entry => entry.id === "steer")).toBe(steered);
    expect(projected.at(-1)?.presentation).toMatchObject({ forkPoint: { turnId: "turn" }, completionDurationMs: 0 });
    expect(projected.at(-2)?.executionGroup?.durationMs).toBe(0);
  });

  it("does not complete an in-progress segment when a user steers the same run", () => {
    const steer = message("steer", { role: "user", content: "顺便检查测试", isSteered: true });
    const projected = groupSessionExecutionMessages([
      user(), message("progress", { content: "继续检查" }), steer, tool,
    ], true);
    const groups = projected.flatMap(entry => entry.executionGroup ? [entry.executionGroup] : []);
    expect(groups).toHaveLength(2);
    expect(groups.every(group => group.isRunning)).toBe(true);
    expect(projected.find(entry => entry.id === steer.id)).toBe(steer);
  });

  it("keeps an explicitly identified streaming final answer outside the process", () => {
    const projected = groupSessionExecutionMessages([user(), tool, {
      ...final, presentation: { reasoning, agentMessagePhase: "final_answer" },
    }], true);
    expect(projected[1].executionGroup?.isRunning).toBe(true);
    expect(projected.at(-1)?.content).toBe(final.content);
    expect(projected.at(-1)?.presentation?.reasoning).toBeUndefined();
  });

  it("does not promote progress before a failed terminal tool to a final answer", () => {
    const projected = groupSessionExecutionMessages([
      user(), message("progress", { content: "开始检查" }), tool,
    ], false);
    expect(projected).toHaveLength(2);
    expect(projected[1].executionGroup?.messages.map(entry => entry.id)).toEqual(["progress", "tool"]);
  });

  it("preserves attachments, named agent output and interaction metadata", () => {
    const attachment = message("attachment", { content: "附件", presentation: {
      attachments: [{ type: "image", name: "result.png", dataUrl: "data:image/png;base64,AA==" }],
    } });
    const subagent = message("subagent", { content: "子任务结果", agentName: "researcher" });
    const question = message("question", { askUser: { questionId: "q", question: "继续？", answered: true, answer: "继续" } });
    const projected = groupSessionExecutionMessages([user(), tool, attachment, subagent, question, final], false);
    for (const preserved of [attachment, subagent, question]) {
      expect(projected.find(entry => entry.id === preserved.id)).toBe(preserved);
    }
  });

  it("uses an actual terminal result on the user when there is no final response", () => {
    const failedUser = { ...user(), presentation: { runResult: {
      status: "failed" as const, reason: "provider_error" as const, durationMs: 5_000,
    } } };
    const projected = groupSessionExecutionMessages([failedUser, tool], true);
    expect(projected[0]).toBe(failedUser);
    expect(projected[1].executionGroup).toMatchObject({ isRunning: false, durationMs: 5_000 });
  });

  it("keeps loaded lazy native traces and their final message untouched", () => {
    const carrier = message("native", { executionTrace: {
      turnId: "turn", revision: "rev", segmentIndex: 1, historyItemKeys: ["tool:call"], liveMessages: [tool],
    } });
    const source = [user(), carrier, final];
    const projected = groupSessionExecutionMessages(source, false);
    expect(projected).toEqual(source);
    expect(projected[1]).toBe(carrier);
    expect(projected[2]).toBe(final);
  });
});
