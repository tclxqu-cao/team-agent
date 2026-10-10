import { describe, expect, it, vi } from "vitest";
import { withCliProgress } from "../bin/cli-progress.mjs";
import {
  buildElevatedPowerShell,
  buildUnlockServiceAdminScript,
  encodePowerShell,
  parseUnlockServiceStatus,
  runUnlockServiceCommand,
  unlockServiceExecutable,
} from "./unlock-service.js";

function result(stdout = "", status = 0, stderr = "") {
  return { pid: 1, output: [null, stdout, stderr], stdout, stderr, status, signal: null, error: undefined };
}

describe("Windows unlock service command", () => {
  it("keeps progress alive during asynchronous elevation and checks state afterwards", async () => {
    vi.useFakeTimers();
    try {
      const runner = vi.fn().mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 6000));
        return result();
      }).mockResolvedValueOnce(result("running"));
      const progress = vi.fn();
      const pending = withCliProgress("等待管理员授权", () => runUnlockServiceCommand("install", "C:\\runtime", {
        platform: "win32", runner, log: vi.fn(),
      }), { log: progress });
      await vi.advanceTimersByTimeAsync(5800);
      expect(progress).toHaveBeenCalledTimes(2);
      expect(runner).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      await pending;
      expect(runner).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("builds an elevated install script without putting credentials on disk or the command line", () => {
    const executable = "C:\\Program Files\\AgentRoam\\agentroam-remote-unlock.exe";
    const admin = buildUnlockServiceAdminScript("install", executable);
    expect(admin).toContain("New-Service");
    expect(admin).toContain("AgentRoamUnlock");
    expect(admin).toContain(`'${executable}'`);
    expect(admin).toContain('"C:\\Program Files\\AgentRoam\\agentroam-remote-unlock.exe" --service');
    const elevated = buildElevatedPowerShell(admin);
    expect(elevated).toContain("-Verb RunAs");
    expect(elevated).toContain("-EncodedCommand");
    expect(Buffer.from(encodePowerShell(admin), "base64").toString("utf16le")).toBe(admin);
  });

  it("reports localized status messages and validates post-install state", async () => {
    const runner = vi.fn()
      .mockReturnValueOnce(result())
      .mockReturnValueOnce(result("running\r\n"));
    const log = vi.fn();
    await runUnlockServiceCommand("install", "C:\\runtime", { platform: "win32", runner, log });
    expect(unlockServiceExecutable("C:\\runtime")).toMatch(/agentroam-remote-unlock\.exe$/);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("远程解锁服务已安装并启动");
  });

  it("fails closed on unsupported platforms, canceled elevation, and unknown status output", async () => {
    await expect(runUnlockServiceCommand("status", "/runtime", { platform: "darwin" })).rejects.toThrow("仅支持 Windows");
    await expect(runUnlockServiceCommand("install", "C:\\runtime", {
      platform: "win32",
      runner: () => result("", 1, "canceled"),
    })).rejects.toThrow("canceled");
    expect(() => parseUnlockServiceStatus("paused")).toThrow("无法读取");
  });
});
