import { describe, expect, it } from "vitest";
import type { AgentEvent, ReasoningSummarySection } from "./entities.js";
import type { NativeSubagentActivity } from "../model/entities.js";
import { mergeReasoningSummaryDelta, reduceRuntimeProgress } from "./native-runtime-events.js";

describe("mergeReasoningSummaryDelta", () => {
  it("appends deltas to the matching section without mutating input", () => {
    const input: ReasoningSummarySection[] = [{ itemId: "reasoning-1", sectionIndex: 0, text: "Inspect" }];
    const result = mergeReasoningSummaryDelta(input, {
      type: "reasoning_summary_delta",
      itemId: "reasoning-1",
      sectionIndex: 0,
      delta: " files",
    });

    expect(result).toEqual([{ itemId: "reasoning-1", sectionIndex: 0, text: "Inspect files" }]);
    expect(input).toEqual([{ itemId: "reasoning-1", sectionIndex: 0, text: "Inspect" }]);
  });

  it("sorts out-of-order sections by section index", () => {
    const later = mergeReasoningSummaryDelta(undefined, {
      type: "reasoning_summary_delta",
      itemId: "reasoning-1",
      sectionIndex: 2,
      delta: "Later",
    });
    const result = mergeReasoningSummaryDelta(later, {
      type: "reasoning_summary_delta",
      itemId: "reasoning-1",
      sectionIndex: 0,
      delta: "First",
    });

    expect(result.map((section) => section.sectionIndex)).toEqual([0, 2]);
  });
});

describe("reduceRuntimeProgress", () => {
  const progress = (progressId: string, label: string): AgentEvent => ({
    type: "runtime_progress",
    progressId,
    phase: "thinking",
    label,
  });

  it("replaces progress with the same id and preserves independent ids", () => {
    expect(reduceRuntimeProgress([
      progress("thinking", "Starting"),
      progress("tool-1", "Running"),
      progress("thinking", "Reasoning"),
    ])).toEqual([
      { progressId: "thinking", phase: "thinking", label: "Reasoning" },
      { progressId: "tool-1", phase: "thinking", label: "Running" },
    ]);
  });

  it.each(["done", "turn_aborted", "error"] as const)("clears progress on %s", (type) => {
    const terminal: AgentEvent = type === "done"
      ? { type, finalText: "" }
      : type === "error"
        ? { type, message: "failed" }
        : { type };
    expect(reduceRuntimeProgress([progress("thinking", "Reasoning"), terminal])).toEqual([]);
  });
});

describe("native subagent event contract", () => {
  it("serializes a display-safe complete activity replacement", () => {
    const activity: NativeSubagentActivity = {
      taskId: "task-1",
      parentToolCallId: "agent-tool-1",
      agentName: "Explore",
      description: "Inspect the repository",
      status: "running",
      isBackgrounded: true,
      messages: [{
        role: "assistant",
        content: "",
        toolCalls: [{ id: "read-1", name: "Read", arguments: { file_path: "src/a.ts" } }],
      }],
    };
    const event: AgentEvent = { type: "native_subagent_update", activity };

    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    expect(JSON.stringify(event)).not.toContain("thinking");
  });
});
