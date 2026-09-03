import { describe, expect, it, vi } from "vitest";
import { prepareCodexRuntimeEnvironment } from "./runtime-manager.js";

describe("prepareCodexRuntimeEnvironment", () => {
  it("injects the resolved absolute Codex executable", async () => {
    const report = vi.fn();
    const environment = await prepareCodexRuntimeEnvironment(
      { PATH: "/bin" },
      { dataDir: "/data", target: "windows-amd64" },
      async () => ({
        executable: "D:\\AgentRoam\\codex.exe",
        version: "0.153.0",
        source: "managed",
      }),
      report,
    );

    expect(environment.AGENT_CODEX_BIN).toBe("D:\\AgentRoam\\codex.exe");
    expect(environment.AGENT_CODEX_RUNTIME_ERROR).toBeUndefined();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("managed"));
  });

  it("removes an unusable inherited override and keeps startup available", async () => {
    const report = vi.fn();
    const environment = await prepareCodexRuntimeEnvironment(
      { PATH: "/bin", AGENT_CODEX_BIN: "/missing/codex" },
      { dataDir: "/data", target: "darwin-arm64" },
      async () => { throw new Error("download failed"); },
      report,
    );

    expect(environment.AGENT_CODEX_BIN).toBeUndefined();
    expect(environment.AGENT_CODEX_RUNTIME_ERROR).toBe("download failed");
    expect(environment.PATH).toBe("/bin");
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining("continue without Codex sessions"));
  });
});
