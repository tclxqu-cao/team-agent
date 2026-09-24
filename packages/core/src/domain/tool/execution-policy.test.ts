import { describe, expect, it } from "vitest";
import {
  ToolExecutionPolicyError,
  validateToolExecutionPolicy,
  type ToolExecutionPolicy,
} from "./execution-policy.js";

function policy(overrides: Partial<ToolExecutionPolicy> = {}): ToolExecutionPolicy {
  return {
    id: "read-only",
    name: "Read only",
    enabled: true,
    allowedTools: ["read_file", "bash"],
    filesystem: { readRoots: ["/tmp"], writeRoots: [], followSymlinks: false },
    commands: {
      mode: "allowlist",
      programs: [{ executable: "/bin/echo", allowedFlags: ["-n"] }],
      inheritedEnvironment: ["PATH"],
    },
    network: "deny",
    limits: { timeoutMs: 30_000, maxOutputBytes: 64_000 },
    ...overrides,
  };
}

describe("validateToolExecutionPolicy", () => {
  it("normalizes a valid policy without retaining caller-owned arrays", () => {
    const input = policy({ allowedTools: [" read_file ", "bash"] });
    const result = validateToolExecutionPolicy(input, { knownTools: ["read_file", "bash"] });
    expect(result.allowedTools).toEqual(["read_file", "bash"]);
    expect(result).not.toBe(input);
  });

  it.each([
    ["invalid id", policy({ id: "bad id" }), "id must use"],
    ["duplicate tools", policy({ allowedTools: ["bash", "bash"] }), "duplicate"],
    ["unknown tools", policy({ allowedTools: ["other"] }), "unknown tool"],
    ["relative roots", policy({ filesystem: { readRoots: ["tmp"], writeRoots: [], followSymlinks: false } }), "absolute"],
    ["empty command rules", policy({ commands: { mode: "allowlist", programs: [], inheritedEnvironment: [] } }), "must not be empty"],
    ["duplicate executables", policy({ commands: { mode: "allowlist", programs: [{ executable: "/bin/echo" }, { executable: "/bin/echo" }], inheritedEnvironment: [] } }), "duplicate command"],
    ["contradictory flags", policy({ commands: { mode: "allowlist", programs: [{ executable: "/bin/echo", allowedFlags: ["-n"], deniedFlags: ["-n"] }], inheritedEnvironment: [] } }), "both allowed and denied"],
    ["bad path indexes", policy({ commands: { mode: "allowlist", programs: [{ executable: "/bin/echo", positionalPathIndexes: [-1] }], inheritedEnvironment: [] } }), "invalid index"],
    ["short timeout", policy({ limits: { timeoutMs: 10, maxOutputBytes: 64_000 } }), "limits.timeoutMs"],
    ["small output limit", policy({ limits: { timeoutMs: 10_000, maxOutputBytes: 10 } }), "limits.maxOutputBytes"],
  ])("rejects %s", (_label, value, message) => {
    expect(() => validateToolExecutionPolicy(value, { knownTools: ["read_file", "bash"] }))
      .toThrow(message as string);
  });

  it("uses the stable invalid-policy code", () => {
    try {
      validateToolExecutionPolicy({});
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolExecutionPolicyError);
      expect(error).toMatchObject({ code: "INVALID_TOOL_POLICY" });
    }
  });
});
