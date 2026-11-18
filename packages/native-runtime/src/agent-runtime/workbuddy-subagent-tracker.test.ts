import { describe, expect, it } from "vitest";
import { WorkBuddySubagentTracker } from "./workbuddy-subagent-tracker.js";

const started = { type: "system", subtype: "task_started", task_id: "child", tool_use_id: "parent-tool", task_type: "Agent", description: "Check files" };
const childText = { type: "stream_event", parent_tool_use_id: "parent-tool", event: { type: "content_block_delta", delta: { type: "text_delta", text: "checking" } } };

describe("WorkBuddy native subagent activity", () => {
  it("keeps an early child stream when native task metadata arrives later", () => {
    const tracker = new WorkBuddySubagentTracker();
    tracker.consume(childText);
    tracker.consume(started);
    const events = tracker.consume({ type: "system", subtype: "task_notification", task_id: "child", status: "completed", summary: "checked" });
    expect(events).toEqual([{ type: "native_subagent_update", activity: expect.objectContaining({
      taskId: "child", parentToolCallId: "parent-tool", agentName: "Agent", description: "Check files", status: "completed",
      messages: [{ role: "assistant", content: "checking" }],
    }) }]);
  });

  it("does not let repeated task_started packets erase output or a terminal status", () => {
    const tracker = new WorkBuddySubagentTracker();
    tracker.consume(started);
    tracker.consume(childText);
    tracker.consume({ type: "system", subtype: "task_updated", task_id: "child", patch: { status: "killed" } });
    expect(tracker.consume(started)).toEqual([{ type: "native_subagent_update", activity: expect.objectContaining({
      status: "stopped", messages: [{ role: "assistant", content: "checking" }],
    }) }]);
  });

  it("does not treat the parent's background launch receipt as child task completion", () => {
    const tracker = new WorkBuddySubagentTracker();
    tracker.consume(started);
    const content = [{ type: "tool_result", tool_use_id: "parent-tool", content: "Task launched in background" }];
    expect(tracker.consume({ type: "user", message: { content } })).toEqual([]);
    expect(tracker.consume(childText)[0]).toMatchObject({ activity: { status: "running" } });
    expect(tracker.consume({ type: "system", subtype: "task_notification", task_id: "child", status: "completed" })[0])
      .toMatchObject({ activity: { status: "completed" } });
  });

  it.each([
    [{ subtype: "success", is_error: false }, "completed"],
    [{ subtype: "error_during_execution", is_error: true }, "failed"],
    [{ subtype: "error_during_execution" }, "failed"],
    [{ subtype: "success", terminal_reason: "aborted_streaming" }, "stopped"],
  ])("uses the child terminal packet's actual status: %j", (terminal, expected) => {
    const tracker = new WorkBuddySubagentTracker();
    tracker.consume(started);
    expect(tracker.consume({ type: "result", parent_tool_use_id: "parent-tool", ...terminal })[0])
      .toMatchObject({ activity: { status: expected } });
  });

  it("keeps snapshots independent while the child stream grows", () => {
    const tracker = new WorkBuddySubagentTracker();
    const initial = tracker.consume(started);
    const first = tracker.consume(childText);
    tracker.consume(childText);
    expect(initial[0]).toMatchObject({ activity: { messages: [] } });
    expect(first[0]).toMatchObject({ activity: { messages: [{ content: "checking" }] } });
  });

  it.each(["stopped", "failed"] as const)("settles only still-running children when the owned process is %s", terminal => {
    const tracker = new WorkBuddySubagentTracker();
    tracker.consume(started);
    tracker.consume({ ...started, task_id: "finished-child", tool_use_id: "finished-tool" });
    tracker.consume({ type: "system", subtype: "task_notification", task_id: "finished-child", status: "completed" });
    expect(tracker.stopActive(terminal)).toEqual([{ type: "native_subagent_update", activity: expect.objectContaining({ taskId: "child", status: terminal }) }]);
    expect(tracker.stopActive(terminal)).toEqual([]);
  });
});
