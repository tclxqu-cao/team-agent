import { describe, expect, it } from "vitest";
import { areToolCallsComplete, hasToolCallResult } from "./tool-call-status";

describe("tool call completion", () => {
  it("treats an empty result as completed", () => {
    expect(hasToolCallResult({ result: "" })).toBe(true);
  });

  it("treats a missing result as running", () => {
    expect(hasToolCallResult({})).toBe(false);
  });

  it("treats a lazy result locator as completed before its body is loaded", () => {
    expect(hasToolCallResult({
      resultRef: { turnId: "turn-1", itemId: "call-1", revision: "rev-1", byteSize: 100_000 },
    })).toBe(true);
  });

  it("requires every restored tool call to have a result field", () => {
    expect(areToolCallsComplete([{ result: "output" }, { result: "" }])).toBe(true);
    expect(areToolCallsComplete([{ result: "output" }, {}])).toBe(false);
  });
});
