import { describe, expect, it } from "vitest";
import { areToolCallsComplete, hasToolCallResult } from "./tool-call-status";

describe("tool call completion", () => {
  it("treats an empty result as completed", () => {
    expect(hasToolCallResult({ result: "" })).toBe(true);
  });

  it("treats a missing result as running", () => {
    expect(hasToolCallResult({})).toBe(false);
  });

  it("requires every restored tool call to have a result field", () => {
    expect(areToolCallsComplete([{ result: "output" }, { result: "" }])).toBe(true);
    expect(areToolCallsComplete([{ result: "output" }, {}])).toBe(false);
  });
});
