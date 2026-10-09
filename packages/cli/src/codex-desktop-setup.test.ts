import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "./args.js";
import { setupCodexDesktop } from "./codex-desktop-setup.js";
import type { DesktopSnapshot } from "./codex-desktop-status.js";

const options = parseArgs(["codex-desktop", "--setup", "--data-dir", "/tmp/agentroam"]);
const idle = { status: "running", appPath: "/Applications/Codex.app", pid: 123, activity: { state: "idle" } } as const;
const busy = { ...idle, activity: { state: "busy", activeCount: 2 } } as const;
const unknown = { ...idle, activity: { state: "unknown", reason: "private stdio" } } as const;

function context(snapshots: DesktopSnapshot[], answer: string | null = null) {
  let index = 0;
  return { platform: "darwin" as const, environment: {}, inspect: vi.fn(async () => snapshots[Math.min(index++, snapshots.length - 1)]!),
    launch: vi.fn(async () => {}), confirm: vi.fn(async () => answer), log: vi.fn() };
}

describe("installation Desktop sharing decisions", () => {
  it("rechecks idle before automatically restarting without a question", async () => {
    const value = context([idle]);
    await setupCodexDesktop(options, value);
    expect(value.inspect).toHaveBeenCalledTimes(2);
    expect(value.confirm).not.toHaveBeenCalled();
    expect(value.launch).toHaveBeenCalledWith(expect.objectContaining({ desktopRestart: true, desktopSetup: false }),
      expect.objectContaining({ AGENTROAM_CODEX_DESKTOP_EXPECTED_PID: "123" }));
  });

  it("starts a stopped Desktop without requesting a restart", async () => {
    const value = context([{ status: "stopped", appPath: idle.appPath }]);
    await setupCodexDesktop(options, value);
    expect(value.confirm).not.toHaveBeenCalled();
    expect(value.launch).toHaveBeenCalledWith(expect.objectContaining({ desktopRestart: false }), expect.objectContaining({ AGENTROAM_CODEX_DESKTOP_EXPECTED_PID: "0" }));
  });

  it.each([busy, unknown])("asks for busy or unqueryable Desktop and restarts only after y", async (snapshot) => {
    const value = context([snapshot], "y");
    await setupCodexDesktop(options, value);
    expect(value.confirm).toHaveBeenCalledWith(expect.stringContaining("中断桌面端的所有运行任务"));
    expect(value.launch).toHaveBeenCalledOnce();
  });

  it.each([null, "", "n", "no", "maybe"])("preserves Desktop after %s or no controlling terminal", async (answer) => {
    const value = context([busy], answer);
    await setupCodexDesktop(options, value);
    expect(value.launch).not.toHaveBeenCalled();
    expect(value.log).toHaveBeenCalledWith(expect.stringContaining("原桌面会话暂未共享"));
  });

  it("asks instead of restarting if a task starts after the first idle snapshot", async () => {
    const value = context([idle, busy]);
    await setupCodexDesktop(options, value);
    expect(value.confirm).toHaveBeenCalledOnce();
    expect(value.launch).not.toHaveBeenCalled();
  });

  it.each([[idle, { ...idle, pid: 124 }], [busy, { ...busy, pid: 124 }]])("does not restart a replaced process", async (snapshots) => {
    const value = context(snapshots, "y");
    await setupCodexDesktop(options, value);
    expect(value.launch).not.toHaveBeenCalled();
  });

  it("skips only a Desktop that is not installed", async () => {
    const value = context([{ status: "not-installed" }]);
    await setupCodexDesktop(options, value);
    expect(value.launch).not.toHaveBeenCalled();
    expect(value.confirm).not.toHaveBeenCalled();
  });

  it("preserves installed service runtime configuration and explicit environment precedence", async () => {
    const value = context([idle]);
    await setupCodexDesktop(options, { ...value, environment: { CODEX_HOME: "/explicit" },
      service: { dataDir: options.dataDir, codexPath: "/managed/codex", codexHome: "/managed/home" } as never });
    expect(value.launch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ CODEX_HOME: "/explicit", AGENT_CODEX_BIN: "/managed/codex" }));
  });

  it("reports launch failure without preventing pairing after install", async () => {
    const value = context([idle]);
    value.launch.mockRejectedValueOnce(new Error("daemon not supported"));
    await setupCodexDesktop(options, value);
    expect(value.log).toHaveBeenCalledWith(expect.stringContaining("桌面共享连接未完成：daemon not supported"));
    expect(value.log).toHaveBeenCalledWith(expect.stringContaining("扫码可连接"));
    expect(value.log).toHaveBeenCalledWith(expect.stringContaining("桌面 → shared → standalone"));
  });
});
