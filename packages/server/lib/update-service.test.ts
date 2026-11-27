import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import type { UpdateChecker } from "@agent/core";
import { describe, expect, it, vi } from "vitest";
import { ServerUpdateService } from "./update-service";

describe("ServerUpdateService", () => {
  it("returns cached status without refreshing", async () => {
    const checker = { schedule: vi.fn(), getStatus: vi.fn(() => ({ phase: "idle", currentVersion: "1.0.0" })), refresh: vi.fn() } as any;
    const service = new ServerUpdateService({ currentVersion: "1.0.0", platform: "darwin-arm64", checker });
    await expect(service.status()).resolves.toMatchObject({ phase: "idle" });
    expect(checker.refresh).not.toHaveBeenCalled();
  });

  it("starts a check without awaiting it", () => {
    let phase = "idle";
    const checker = {
      schedule: vi.fn(),
      getStatus: vi.fn(() => ({ phase, currentVersion: "1.0.0" })),
      refresh: vi.fn(() => {
        phase = "checking";
        return new Promise(() => {});
      }),
    } as any;
    const service = new ServerUpdateService({ currentVersion: "1.0.0", platform: "darwin-arm64", checker });
    expect(service.requestCheck()).toMatchObject({ phase: "checking" });
    expect(checker.refresh).toHaveBeenCalledOnce();
    expect(checker.refresh).toHaveBeenCalledWith({ force: true });
  });

  it("refuses install outside a packaged service", async () => {
    const service = new ServerUpdateService({ currentVersion: "1.0.0", platform: null });
    await expect(service.status()).resolves.toMatchObject({
      phase: "unavailable", message: expect.stringContaining("AgentRoam CLI"),
    });
    await expect(service.installAvailable()).rejects.toThrow("packaged AgentRoam service");
  });

  it("launches one worker for the computer's validated version when installation is confirmed", async () => {
    const update = { phase: "available", currentVersion: "1.0.0", targetVersion: "1.1.0-preview.3" };
    const checker = { schedule: vi.fn(), getStatus: vi.fn(() => update) } as unknown as UpdateChecker;
    const worker = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const run = vi.fn(() => worker);
    const service = new ServerUpdateService({
      currentVersion: update.currentVersion, platform: "darwin-arm64", checker,
      dataDir: "/fixtures/agentroam-update", cliPath: "/fixtures/agentroam.mjs", spawn: run as unknown as typeof spawn,
    });
    await expect(service.status()).resolves.toMatchObject(update);
    expect(run).not.toHaveBeenCalled();
    await expect(Promise.all([service.installAvailable(), service.installAvailable()])).resolves.toEqual([
      { ...update, phase: "downloading" }, { ...update, phase: "downloading" },
    ]);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(process.execPath,
      ["/fixtures/agentroam.mjs", "update", update.targetVersion, "--data-dir", "/fixtures/agentroam-update"],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
  });
});
