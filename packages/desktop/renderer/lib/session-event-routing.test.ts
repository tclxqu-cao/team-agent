import { describe, expect, it } from "vitest";
import { resolveSessionEventTarget } from "./session-event-routing";

describe("resolveSessionEventTarget", () => {
  it("preserves explicit event ownership", () => {
    expect(resolveSessionEventTarget("ca-session")).toBe("ca-session");
    expect(resolveSessionEventTarget("runtime:codex:abc")).toBe("runtime:codex:abc");
  });

  it("rejects events without explicit session ownership", () => {
    expect(resolveSessionEventTarget(undefined)).toBeNull();
    expect(resolveSessionEventTarget(null)).toBeNull();
    expect(resolveSessionEventTarget("")).toBeNull();
    expect(resolveSessionEventTarget("   ")).toBeNull();
  });
});
