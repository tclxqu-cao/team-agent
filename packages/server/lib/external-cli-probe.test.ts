import { afterEach, describe, expect, it } from "vitest";
import { resolveExternalCli } from "./external-cli-probe";

const environmentBackup = { ...process.env };

afterEach(() => {
  process.env = { ...environmentBackup };
});

describe("resolveExternalCli", () => {
  it("keeps a usable injected pin", () => {
    process.env.AGENT_TEST_CLI_BIN = process.execPath;
    const resolution = resolveExternalCli({
      name: "node",
      environmentVariable: "AGENT_TEST_CLI_BIN",
    });
    expect(resolution.source).toBe("pin");
    expect(resolution.executable).toBe(process.execPath);
    expect(resolution.detail).not.toContain("rejected");
  });

  it("falls back to a PATH install when the injected pin cannot be executed", () => {
    // The failure mode this guards: a managed-runtime path pinned by the
    // supervisor that was never installed, which used to be trusted blindly
    // and surface only as `spawn <path> ENOENT`.
    process.env.AGENT_TEST_CLI_BIN = "/nonexistent/agentroam/runtimes/codex/0.153.0/bin/codex";
    const resolution = resolveExternalCli({
      name: "node",
      environmentVariable: "AGENT_TEST_CLI_BIN",
    });
    expect(resolution.source).toBe("path");
    expect(resolution.executable).toBeTruthy();
    expect(resolution.detail).toContain("is not executable");
  });

  it("reports nothing usable instead of returning a path that cannot spawn", () => {
    const resolution = resolveExternalCli({
      name: "definitely-not-a-real-cli-xyz",
      environmentVariable: "AGENT_MISSING_CLI_BIN",
    });
    expect(resolution.executable).toBeUndefined();
    expect(resolution.detail).toContain("No usable");
    expect(resolution.detail).toContain("AGENT_DEFINITELY-NOT-A-REAL-CLI-XYZ_BIN");
  });
});
