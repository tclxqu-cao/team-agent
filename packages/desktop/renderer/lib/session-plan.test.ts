import { describe, expect, it } from "vitest";
import type { ChatMessage, TodoItem } from "../stores/agentStore";
import { hasSessionPlanAdditions, latestSessionPlan, normalizeSessionPlan, sessionPlanSnapshot, successfulSessionPlanAddition, successfulSessionPlanUpdate } from "./session-plan";

let sequence = 0;
function call(name: string, args: Record<string, unknown>, result?: string): ChatMessage {
  const id = `tool-${++sequence}`;
  return { id, role: "assistant", content: "", timestamp: sequence,
    toolCalls: [{ id, name, arguments: args, ...(result === undefined ? {} : { result }) }] };
}

describe("shared Agent execution plans", () => {
  it.each([
    ["Codex", "functions.update_plan", { plan: [{ step: "检查", status: "in_progress" }] }],
    ["Claude Code", "TodoWrite", { todos: [{ content: "检查", status: "in_progress" }] }],
    ["OpenCode", "todo_write", { todos: [{ content: "检查", status: "in_progress" }] }],
    ["DeepSeek Harness", "write_todos", { todos: [{ content: "检查", status: "in_progress" }] }],
    ["Qoder", "TodoWrite", { todos: [{ content: "检查", status: "in_progress" }] }],
    ["ZCode", "todowrite", { todos: [{ content: "检查", status: "in_progress" }] }],
    ["WorkBuddy", "TodoWrite", { todos: [{ content: "检查", status: "in_progress" }] }],
    ["VS Code Copilot", "manage_todo_list", { operation: "write", todoList: [{ id: 1, title: "检查", status: "in-progress" }] }],
  ])("restores %s tool snapshots through the shared projection", (_agent, name, args) => {
    expect(latestSessionPlan([call(name, args)])[0]).toMatchObject({ title: "检查", status: "in-progress" });
  });

  it("replays Customer Agent additions and partial-title status updates", () => {
    const messages = [call("todo_add", { todos: [{ title: "检查页面" }, { title: "适配手机" }] }),
      call("todo_update", { title: "检查", status: "completed" })];
    expect(latestSessionPlan(messages).map(item => [item.title, item.status])).toEqual([
      ["检查页面", "completed"], ["适配手机", "pending"],
    ]);
  });

  it("replays Claude task creation, completion, renaming and deletion", () => {
    const messages = [call("TaskCreate", { subject: "原任务" }, "Task #1 created successfully: 原任务"),
      call("TaskCreate", { subject: "删除任务" }, JSON.stringify({ task: { id: "2" } })),
      call("TaskUpdate", { taskId: "1", subject: "适配手机", status: "completed" }),
      call("TaskUpdate", { taskId: "2", status: "deleted" })];
    expect(latestSessionPlan(messages)).toEqual([{ id: "1", title: "适配手机", status: "completed" }]);
  });

  it("honors an explicitly cleared plan inside a native execution trace", () => {
    const earlier = call("update_plan", { plan: [{ step: "旧计划", status: "completed" }] });
    const clear = call("functions.update_plan", { plan: [] });
    const trace: ChatMessage = { id: "trace", role: "assistant", content: "", timestamp: 10,
      executionTrace: { turnId: "turn", revision: "revision", liveMessages: [clear] } };
    expect(sessionPlanSnapshot([earlier, trace])).toEqual([]);
    expect(sessionPlanSnapshot([])).toBeNull();
  });

  it("keeps sessions separate and ignores failed snapshots", () => {
    const failed = call("TodoWrite", { todos: [{ content: "失败计划" }] });
    failed.toolCalls![0].isError = true;
    expect(latestSessionPlan([call("TodoWrite", { todos: [{ content: "会话 A" }] }), failed])[0].title).toBe("会话 A");
    expect(latestSessionPlan([call("TodoWrite", { todos: [{ content: "会话 B" }] })])[0].title).toBe("会话 B");
  });

  it("normalizes native states, preserves dependencies and rejects malformed snapshots", () => {
    expect(normalizeSessionPlan([{ id: "1", content: "开始", status: "inProgress", dependsOn: ["前置", 3] }]))
      .toEqual([{ id: "1", title: "开始", status: "in-progress", dependsOn: ["前置"] }]);
    expect(normalizeSessionPlan([{ status: "completed" }])).toBeNull();
  });
});

describe("plan additions that reveal the task panel", () => {
  const items = (...titles: string[]): TodoItem[] => titles.map((title, index) => ({ id: String(index), title, status: "pending" }));
  const complete = (message: ChatMessage, content = "success", isError = false) => ({
    toolCallId: message.toolCalls![0].id, content, isError,
  });

  it("ignores status, ordering, whitespace and regenerated IDs", () => {
    const previous = items("检查", "验证");
    const next: TodoItem[] = [{ id: "new-2", title: " 验证 ", status: "completed" },
      { id: "new-1", title: "检查", status: "in-progress" }];
    expect(hasSessionPlanAdditions(previous, next)).toBe(false);
    expect(hasSessionPlanAdditions(previous, items("检查"))).toBe(false);
    expect(hasSessionPlanAdditions(previous, [])).toBe(false);
    expect(hasSessionPlanAdditions([], items("  "))).toBe(false);
  });

  it("detects replacements and additional occurrences of the same title", () => {
    expect(hasSessionPlanAdditions(items("检查"), items("验证"))).toBe(true);
    expect(hasSessionPlanAdditions(items("检查"), items("检查", "检查"))).toBe(true);
    expect(hasSessionPlanAdditions(items("检查", "检查"), items(" 检查 ", "检查"))).toBe(false);
  });

  it("requires a matching successful result instead of pending tool arguments", () => {
    const pending = call("TodoWrite", { todos: [{ content: "新增计划" }] });
    expect(successfulSessionPlanAddition([], complete(pending))).toBeNull();
    expect(successfulSessionPlanAddition([pending], { toolCallId: "other", content: "success" })).toBeNull();
    expect(successfulSessionPlanAddition([pending], { toolCallId: pending.toolCalls![0].id })).toBeNull();
    expect(successfulSessionPlanAddition([pending], complete(pending, "failed", true))).toBeNull();
    expect(successfulSessionPlanAddition([pending], complete(pending)))
      .toEqual([{ id: "plan-0", title: "新增计划", status: "pending" }]);
  });

  it("uses an existing inline success result when the arriving result is only a reference", () => {
    const completed = call("TaskCreate", { subject: "新增计划" }, JSON.stringify({ task: { id: "1" } }));
    expect(successfulSessionPlanAddition([completed], { toolCallId: completed.toolCalls![0].id }))
      .toEqual([{ id: "1", title: "新增计划", status: "pending" }]);
    completed.toolCalls![0].isError = true;
    expect(successfulSessionPlanAddition([completed], { toolCallId: completed.toolCalls![0].id })).toBeNull();
  });

  it.each([
    ["TaskList", {}],
    ["todo_list", {}],
    ["manage_todo_list", { operation: "read", todoList: [{ title: "已有计划" }] }],
    ["TaskUpdate", { taskId: "1", subject: "改名", status: "completed" }],
    ["todo_update", { title: "旧计划", status: "completed" }],
  ])("does not reveal the panel for %s reads or individual updates", (name, args) => {
    const previous = call("TaskCreate", { subject: "旧计划" }, JSON.stringify({ task: { id: "1" } }));
    const update = call(name, args);
    expect(successfulSessionPlanAddition([previous, update], complete(update, JSON.stringify([{ id: "2", title: "已有计划" }])))).toBeNull();
  });

  it("keeps the panel hidden when a plan write only updates progress or clears the plan", () => {
    const previous = call("TodoWrite", { todos: [{ id: "old", content: "检查", status: "pending" }] }, "success");
    const progress = call("TodoWrite", { todos: [{ id: "new", content: " 检查 ", status: "completed" }] });
    expect(successfulSessionPlanAddition([previous, progress], complete(progress))).toBeNull();
    expect(successfulSessionPlanUpdate([previous, progress], complete(progress))?.plan)
      .toEqual([{ id: "new", title: " 检查 ", status: "completed" }]);
    const clear = call("functions.update_plan", { plan: [] });
    expect(successfulSessionPlanAddition([previous, clear], complete(clear))).toBeNull();
    const malformed = call("TodoWrite", { todos: [{ status: "pending" }] });
    expect(successfulSessionPlanAddition([malformed], complete(malformed))).toBeNull();
  });

  it.each([
    ["TaskUpdate", { taskId: "1", status: "completed" }],
    ["todo_update", { title: "检查", status: "completed" }],
  ])("refreshes successful %s progress silently instead of leaving the cached plan unchanged", (name, args) => {
    const previous = call("TaskCreate", { subject: "检查" }, JSON.stringify({ task: { id: "1" } }));
    const progress = call(name, args);
    const update = successfulSessionPlanUpdate([previous, progress], complete(progress));
    expect(update).toEqual({
      previous: [{ id: "1", title: "检查", status: "pending" }],
      plan: [{ id: "1", title: "检查", status: "completed" }],
    });
    expect(successfulSessionPlanAddition([previous, progress], complete(progress))).toBeNull();
    const failed = complete(progress, "failed", true);
    expect(successfulSessionPlanUpdate([previous, progress], failed)).toBeNull();
  });

  it("returns a successful cleared plan so the caller can remove stale cached tasks", () => {
    const previous = call("TodoWrite", { todos: [{ content: "检查" }] }, "success");
    const clear = call("TodoWrite", { todos: [] });
    expect(successfulSessionPlanUpdate([previous, clear], complete(clear))).toEqual({
      previous: [{ id: "plan-0", title: "检查", status: "pending" }], plan: [],
    });
    expect(successfulSessionPlanAddition([previous, clear], complete(clear))).toBeNull();
  });

  it("returns the full resulting plan when a successful incremental tool adds a task", () => {
    const previous = call("TaskCreate", { subject: "检查" }, JSON.stringify({ task: { id: "1" } }));
    const added = call("TaskCreate", { subject: "验证" });
    expect(successfulSessionPlanAddition([previous, added], complete(added, JSON.stringify({ task: { id: "2" } }))))
      .toEqual([{ id: "1", title: "检查", status: "pending" }, { id: "2", title: "验证", status: "pending" }]);
    const customerAdded = call("todo_add", { todos: [{ title: "发布" }] });
    expect(successfulSessionPlanAddition([previous, customerAdded], complete(customerAdded))?.map(item => item.title))
      .toEqual(["检查", "发布"]);
  });

  it("completes tools inside nested execution traces without mutating the pending messages", () => {
    const pending = call("functions.update_plan", { plan: [{ step: "新增计划", status: "in_progress" }] });
    const nested: ChatMessage = { id: "nested", role: "assistant", content: "", timestamp: 11,
      executionTrace: { turnId: "nested", revision: "revision", liveMessages: [pending] } };
    const trace: ChatMessage = { id: "trace", role: "assistant", content: "", timestamp: 12,
      executionTrace: { turnId: "turn", revision: "revision", liveMessages: [nested] } };
    const messages = [trace];
    const before = JSON.stringify(messages);
    expect(successfulSessionPlanAddition(messages, complete(pending)))
      .toEqual([{ id: "plan-0", title: "新增计划", status: "in-progress" }]);
    expect(JSON.stringify(messages)).toBe(before);
    expect(pending.toolCalls![0].result).toBeUndefined();
  });
});
