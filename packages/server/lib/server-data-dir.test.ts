import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentWorkingDirectory, resolveServerLogDir } from "./server-data-dir";

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

describe("resolveServerLogDir", () => {
  it("falls back to <baseDir>/.agent-data/logs when nothing is injected", () => {
    expect(resolveServerLogDir({ NODE_ENV: "test" }, "/opt/customer-agent/data")).toBe(
      join("/opt/customer-agent/data", ".agent-data", "logs"),
    );
  });

  it("honours AGENT_LOG_DIR so installed runs land next to service.stdout.log", () => {
    expect(resolveServerLogDir(
      { NODE_ENV: "test", AGENT_LOG_DIR: "/Users/example/.agentroam/logs" },
      "/opt/customer-agent/data",
    )).toBe("/Users/example/.agentroam/logs");
  });

  it("ignores a blank AGENT_LOG_DIR instead of writing into the cwd", () => {
    expect(resolveServerLogDir({ NODE_ENV: "test", AGENT_LOG_DIR: "  " }, "/opt/customer-agent/data")).toBe(
      join("/opt/customer-agent/data", ".agent-data", "logs"),
    );
  });
});
