import { describe, expect, it } from "vitest";
import { shouldSuppressTouchScrollInput } from "./terminalInputPolicy";

describe("shouldSuppressTouchScrollInput", () => {
  it.each(["a", "l", "\x7f", "echo echo"])("allows repeated terminal data %j", (data) => {
    expect(shouldSuppressTouchScrollInput(data, false)).toBe(false);
    expect(shouldSuppressTouchScrollInput(data, false)).toBe(false);
    expect(shouldSuppressTouchScrollInput(data, true)).toBe(false);
    expect(shouldSuppressTouchScrollInput(data, true)).toBe(false);
  });

  it.each(["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"])(
    "suppresses %j only during touch scrolling",
    (data) => {
      expect(shouldSuppressTouchScrollInput(data, true)).toBe(true);
      expect(shouldSuppressTouchScrollInput(data, false)).toBe(false);
    },
  );
});
