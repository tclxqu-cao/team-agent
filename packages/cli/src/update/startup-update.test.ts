import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { updateBeforeStartup } from "./startup-update.js";
import { resolveUpdateCandidate } from "./update-command.js";
import { acquireUpdateLock, updatePaths } from "./update-state.js";
import { cliLauncherPath, installCliLauncher } from "./update-install.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));
vi.mock("./update-command.js", () => ({ resolveUpdateCandidate: vi.fn() }));
vi.mock("./update-state.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./update-state.js")>(),
  acquireUpdateLock: vi.fn(),
}));
vi.mock("./update-install.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./update-install.js")>(),
  installCliLauncher: vi.fn(),
}));

const dataDir = resolve("test-install");
const options = {
  cliPath: cliLauncherPath(dataDir, "1.0.0"),
  currentVersion: "1.0.0",
  target: "darwin-arm64" as const,
  roots: ["/project"],
};
const release = { targetVersion: "1.0.1-preview.1", fileName: "install-agentroam.sh", sha256: "a".repeat(64) };
const entry = cliLauncherPath(dataDir, release.targetVersion);
const unlock = vi.fn(async () => {});
const exitCode = process.exitCode;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("AGENTROAM_SKIP_STARTUP_UPDATE", undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(acquireUpdateLock).mockResolvedValue(unlock);
  vi.mocked(resolveUpdateCandidate).mockResolvedValue(release);
  vi.mocked(installCliLauncher).mockResolvedValue(entry);
});

afterEach(() => {
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("foreground CLI startup update", () => {
  it("leaves source checkouts and a handoff from the prior launcher alone", async () => {
    await expect(updateBeforeStartup({ ...options, cliPath: resolve("packages/cli/bin/agentroam.mjs") }, [])).resolves.toBe("unmanaged");
    vi.stubEnv("AGENTROAM_SKIP_STARTUP_UPDATE", "1");
    await expect(updateBeforeStartup(options, [])).resolves.toBe("current");
    expect(resolveUpdateCandidate).not.toHaveBeenCalled();
  });

  it("starts the current version when no newer release is published", async () => {
    vi.mocked(resolveUpdateCandidate).mockResolvedValue(null);
    await expect(updateBeforeStartup(options, [])).resolves.toBe("current");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("已是最新版本"));
    expect(acquireUpdateLock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("installs under the launcher lock and continues with the same CLI arguments", async () => {
    const child = new EventEmitter();
    const execve = process.platform === "darwin" && process.execve ? vi.spyOn(process, "execve").mockImplementation(() => {
      expect(unlock).toHaveBeenCalledOnce();
    }) : null;
    vi.mocked(spawn).mockImplementation(() => {
      expect(unlock).toHaveBeenCalledOnce();
      queueMicrotask(() => child.emit("exit", 0, null));
      return child as ReturnType<typeof spawn>;
    });
    const argv = ["start", "--local-only", "--root", "/project"];
    await expect(updateBeforeStartup(options, argv)).resolves.toBe("launched");
    expect(acquireUpdateLock).toHaveBeenCalledWith(updatePaths(dataDir).lockFile);
    expect(installCliLauncher).toHaveBeenCalledWith({ ...release, dataDir, roots: options.roots });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("1.0.0 → 1.0.1-preview.1"));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("已安装，正在启动"));
    if (execve) {
      expect(execve).toHaveBeenCalledWith(process.execPath, [process.execPath, entry, ...argv],
        expect.objectContaining({ AGENTROAM_SKIP_STARTUP_UPDATE: "1" }));
    } else {
      expect(spawn).toHaveBeenCalledWith(process.execPath, [entry, ...argv], {
        stdio: "inherit",
        env: expect.objectContaining({ AGENTROAM_SKIP_STARTUP_UPDATE: "1" }),
      });
    }
  });

  it("releases the lock and falls back to the current CLI on a failed install", async () => {
    vi.mocked(installCliLauncher).mockRejectedValue(new Error("installer checksum mismatch"));
    await expect(updateBeforeStartup(options, [])).resolves.toBe("current");
    expect(unlock).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("自动更新未完成，继续启动当前版本"));
  });
});
