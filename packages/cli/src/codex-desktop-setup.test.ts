vi.mock("./codex-sharing.js", async importOriginal => ({ ...await importOriginal<typeof import("./codex-sharing.js")>(), configureCodexSharing: vi.fn(async () => {}) }));
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "./args.js";
import { configureCodexSharing } from "./codex-sharing.js";
import { setupCodexDesktop } from "./codex-desktop-setup.js";
import type { DesktopSnapshot } from "./codex-desktop-status.js";

const options = parseArgs(["codex-desktop", "--setup", "--data-dir", "/tmp/agentroam"]);
const idle = { status: "running", appPath: "/Applications/Codex.app", pid: 123, activity: { state: "idle" } } as const;
const busy = { ...idle, activity: { state: "busy", activeCount: 2 } } as const;
const unknown = { ...idle, activity: { state: "unknown", reason: "private stdio" } } as const;

function context(snapshots: DesktopSnapshot[], answer: string | null = null) {
  let index = 0;
  return { platform: "darwin" as const, environment: {}, inspect: vi.fn(async () => snapshots[Math.min(index++, snapshots.length - 1)]!),
    inspectSharing: vi.fn(async () => ({ state: "independent" }) as never),
    launch: vi.fn(async () => {}), confirm: vi.fn(async () => answer), log: vi.fn() };
}

describe("installation Desktop sharing decisions", () => {
  it("reports CLI-owned confirmation requirements to graphical callers without opening a terminal prompt", async () => {
    const value = context([busy]);
    await setupCodexDesktop(options, { ...value, environment: { AGENTROAM_CODEX_DESKTOP_NONINTERACTIVE: "1" } });
    expect(value.log).toHaveBeenCalledWith(JSON.stringify({ codexSharingAction: "confirmation-required" }));
    expect(value.confirm).not.toHaveBeenCalled();
    expect(value.launch).not.toHaveBeenCalled();
  });
  it("preserves an already shared Desktop", async () => {
    const value = context([idle]);
    value.inspectSharing.mockResolvedValue({ state: "shared" } as never);
    await setupCodexDesktop(options, value);
    expect(value.launch).not.toHaveBeenCalled();
    expect(value.confirm).not.toHaveBeenCalled();
  });
  it("rechecks idle before automatically restarting without a question", async () => {
    const value = context([idle]);
    await setupCodexDesktop(options, value);
    expect(value.inspect).toHaveBeenCalledTimes(2);
    expect(value.confirm).not.toHaveBeenCalled();
    expect(value.launch).toHaveBeenCalledWith(expect.objectContaining({ desktopRestart: true, desktopSetup: false }),
      expect.objectContaining({ AGENTROAM_CODEX_DESKTOP_EXPECTED_PID: "123" }));
  });

  it("configures the backend without opening a stopped Desktop", async () => {
    const value = context([{ status: "stopped", appPath: idle.appPath }]);
    await setupCodexDesktop(options, value);
    expect(value.confirm).not.toHaveBeenCalled();
    expect(value.launch).not.toHaveBeenCalled();
  });

  it.each([busy, unknown])("asks for busy or unqueryable Desktop and restarts only after y", async (snapshot) => {
    const value = context([snapshot], "y");
    await setupCodexDesktop(options, value);
    expect(value.confirm).toHaveBeenCalledWith(expect.stringContaining("interrupt all running desktop tasks"));
    expect(value.launch).toHaveBeenCalledOnce();
  });

  it.each([null, "", "n", "no", "maybe"])("preserves Desktop after %s or no controlling terminal", async (answer) => {
    const value = context([busy], answer);
    await setupCodexDesktop(options, value);
    expect(value.launch).not.toHaveBeenCalled();
    expect(configureCodexSharing).toHaveBeenCalled();
    expect(value.log).toHaveBeenCalledWith(expect.stringContaining("existing desktop sessions are not shared yet"));
  });

  it("asks instead of restarting if a task starts after the first idle snapshot", async () => {
    const value = context([idle, busy]);
    await setupCodexDesktop(options, value);
    expect(value.confirm).toHaveBeenCalledOnce();
    expect(value.launch).not.toHaveBeenCalled();
  });

  it.each([{ snapshots: [idle, { ...idle, pid: 124 }] }, { snapshots: [busy, { ...busy, pid: 124 }] }])("does not restart a replaced process", async ({ snapshots }) => {
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
    expect(value.log).toHaveBeenCalledWith(expect.stringContaining("Desktop sharing connection incomplete: daemon not supported"));
    expect(value.log).toHaveBeenCalledWith(expect.stringContaining("scan to connect"));
    expect(value.log).toHaveBeenCalledWith(expect.stringContaining("desktop -> shared -> standalone"));
  });
});
