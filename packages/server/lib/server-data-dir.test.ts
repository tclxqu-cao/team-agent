import { describe, expect, it } from "vitest";
import { resolveAgentWorkingDirectory } from "./server-data-dir";

describe("resolveAgentWorkingDirectory", () => {
  it("uses the server directory instead of inheriting a launch daemon cwd", () => {
    expect(resolveAgentWorkingDirectory({}, "/opt/customer-agent/server")).toBe(
      "/opt/customer-agent/server",
    );
  });

  it("allows an explicit agent workspace override", () => {
    expect(resolveAgentWorkingDirectory(
      { AGENT_WORKING_DIRECTORY: "/Users/example/project" },
      "/opt/customer-agent/server",
    )).toBe("/Users/example/project");
  });
});
