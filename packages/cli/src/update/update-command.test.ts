import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveUpdate } from "./update-command.js";
import { acquireUpdateLock, readUpdateState, updatePaths, writeUpdateState, type DurableUpdateState } from "./update-state.js";

const sha256 = "c".repeat(64);
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("resolveUpdate", () => {
  it("accepts only npm latest with an audited Gitee installer", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ version: "1.2.3" }))
      .mockResolvedValueOnce(response({ schemaVersion: 2, version: "1.2.3", channel: "latest", installers: { cli: { "windows-amd64": { fileName: "install-agentroam.ps1", sha256 } } } }));
    await expect(resolveUpdate({ currentVersion: "1.2.2", requestedVersion: null, dataDir: "data", target: "windows-amd64", cliPath: "cli" }, fetcher))
      .resolves.toEqual({ targetVersion: "1.2.3", fileName: "install-agentroam.ps1", sha256 });
  });

  it("rejects a requested version that is not npm latest", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ version: "1.2.3" }));
    await expect(resolveUpdate({ currentVersion: "1.0.0", requestedVersion: "1.2.2", dataDir: "data", target: "darwin-arm64", cliPath: "cli" }, fetcher)).rejects.toThrow("not the current npm latest");
  });

  it("writes durable state atomically and excludes concurrent workers", async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), "agentroam-update-state-"));
    const paths = updatePaths(dataDir);
    const state: DurableUpdateState = {
      schemaVersion: 1, phase: "downloading", currentVersion: "1.0.0", targetVersion: "1.1.0",
      dataDir, roots: ["D:\\project"], port: 3000, relay: "auto", tunnelCommand: null,
      localOnly: false, fileName: "install-agentroam.ps1", sha256, cliPath: "C:\\agentroam.mjs", updatedAt: 1,
    };
    await writeUpdateState(paths.stateFile, state);
    await expect(readUpdateState(paths.stateFile)).resolves.toEqual(state);
    const release = await acquireUpdateLock(paths.lockFile);
    await expect(acquireUpdateLock(paths.lockFile)).rejects.toThrow("already running");
    await release();
  });
});
