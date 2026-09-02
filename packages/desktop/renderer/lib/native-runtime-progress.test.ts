import { describe, expect, it } from "vitest";
import type { RuntimeProgress } from "@agent/core";
import {
  latestGlobalRuntimeProgress,
  mergeReasoningSummaryDelta,
  reduceRuntimeProgressEvents,
  toolRuntimeProgress,
  upsertRuntimeProgress,
} from "./native-runtime-progress";

const progress = (progressId: string, label: string, toolCallId?: string): RuntimeProgress => ({
  progressId,
  phase: toolCallId ? "tool" : "thinking",
  label,
  ...(toolCallId ? { toolCallId } : {}),
});

describe("native runtime progress", () => {
  it("replaces matching progress without growing the collection", () => {
    const first = upsertRuntimeProgress([], progress("thinking", "Starting"));
    const next = upsertRuntimeProgress(first, progress("thinking", "Reasoning"));

    expect(next).toEqual([progress("thinking", "Reasoning")]);
    expect(first).toEqual([progress("thinking", "Starting")]);
  });

  it("associates tool progress and keeps the latest unassociated row", () => {
    const values = [
      progress("thinking", "Thinking"),
      progress("tool", "Running shell", "call-1"),
      progress("retry", "Retrying"),
    ];

    expect(toolRuntimeProgress(values, "call-1")?.label).toBe("Running shell");
    expect(latestGlobalRuntimeProgress(values)?.label).toBe("Retrying");
  });

  it("merges summary deltas and clears restored progress on terminal events", () => {
    const sections = mergeReasoningSummaryDelta(undefined, {
      type: "reasoning_summary_delta",
      itemId: "reasoning-1",
      sectionIndex: 0,
      delta: "Inspect files",
    });
    expect(sections[0].text).toBe("Inspect files");
    expect(reduceRuntimeProgressEvents([
      { type: "runtime_progress", progressId: "thinking", phase: "thinking", label: "Thinking" },
      { type: "done", finalText: "Done" },
    ])).toEqual([]);
  });
});
