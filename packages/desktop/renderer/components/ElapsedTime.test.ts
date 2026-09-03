import { describe, expect, it } from "vitest";
import { elapsedSeconds } from "./ElapsedTime";

describe("elapsedSeconds", () => {
  it("reports whole elapsed seconds without returning negative values", () => {
    expect(elapsedSeconds(1_000, 3_999)).toBe(2);
    expect(elapsedSeconds(3_000, 2_000)).toBe(0);
  });
});
