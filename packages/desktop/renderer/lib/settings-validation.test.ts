import { describe, expect, it } from "vitest";
import { parseMaxIterationsDraft } from "./settings-validation";

describe("parseMaxIterationsDraft", () => {
  it.each([
    ["0", 0],
    ["10", 10],
    ["5000", 5000],
  ])("parses %s as %i", (draft, expected) => {
    expect(parseMaxIterationsDraft(draft)).toBe(expected);
  });

  it.each(["", " ", "-1", "1.5", "not-a-number"])("rejects %j", (draft) => {
    expect(parseMaxIterationsDraft(draft)).toBeNull();
  });
});
