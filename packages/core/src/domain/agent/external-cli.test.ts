import { describe, expect, it } from "vitest";
import {
  CODEX_MINIMUM_VERSION,
  isVersionAtLeast,
  parseVersion,
  selectExternalCli,
  type ExternalCliCandidate,
} from "./external-cli.js";

const pin = (overrides: Partial<ExternalCliCandidate> = {}): ExternalCliCandidate => ({
  source: "pin",
  path: "/opt/pinned/codex",
  executable: true,
  version: "0.155.0",
  ...overrides,
});

const onPath = (overrides: Partial<ExternalCliCandidate> = {}): ExternalCliCandidate => ({
  source: "path",
  path: "/usr/local/bin/codex",
  executable: true,
  version: "0.155.0",
  ...overrides,
});

describe("parseVersion", () => {
  it("reads the version out of CLI output", () => {
    expect(parseVersion("codex-cli 0.155.0")).toBe("0.155.0");
    expect(parseVersion("1.18.31")).toBe("1.18.31");
  });

  it("returns undefined when there is no semver to read", () => {
    expect(parseVersion("unknown")).toBeUndefined();
  });
});

describe("isVersionAtLeast", () => {
  it("compares numeric components, not strings", () => {
    expect(isVersionAtLeast("0.153.10", "0.153.2")).toBe(true);
    expect(isVersionAtLeast("0.154.0", "0.153.2")).toBe(true);
    expect(isVersionAtLeast("0.153.1", "0.153.2")).toBe(false);
  });

  it("treats a missing component as zero", () => {
    expect(isVersionAtLeast("0.153", "0.153.0")).toBe(true);
  });
});

describe("selectExternalCli", () => {
  it("prefers a working pin over a PATH install", () => {
    const resolution = selectExternalCli([pin(), onPath()], { name: "codex" });
    expect(resolution.executable).toBe("/opt/pinned/codex");
    expect(resolution.source).toBe("pin");
    expect(resolution.detail).not.toContain("rejected");
  });

  it("falls back to PATH when the injected pin cannot be executed", () => {
    const resolution = selectExternalCli([pin({ executable: false }), onPath()], { name: "codex" });
    expect(resolution.executable).toBe("/usr/local/bin/codex");
    expect(resolution.source).toBe("path");
    expect(resolution.detail).toContain("not executable");
  });

  it("refuses a PATH candidate below the compatibility floor", () => {
    const resolution = selectExternalCli(
      [pin({ executable: false }), onPath({ version: "0.151.0" })],
      { name: "codex", minimumVersion: CODEX_MINIMUM_VERSION },
    );
    expect(resolution.executable).toBeUndefined();
    expect(resolution.detail).toContain("below 0.153.0");
  });

  it("accepts an unknown version rather than refusing to start", () => {
    const resolution = selectExternalCli([onPath({ version: undefined })], {
      name: "codex",
      minimumVersion: CODEX_MINIMUM_VERSION,
    });
    expect(resolution.executable).toBe("/usr/local/bin/codex");
  });

  it("reports every rejection and the install hint when nothing is usable", () => {
    const resolution = selectExternalCli(
      [pin({ executable: false }), onPath({ executable: false })],
      { name: "codex", minimumVersion: CODEX_MINIMUM_VERSION },
    );
    expect(resolution.executable).toBeUndefined();
    expect(resolution.detail).toContain("No usable \"codex\"");
    expect(resolution.detail).toContain("AGENT_CODEX_BIN");
    expect(resolution.detail).toContain("not executable");
  });
});
