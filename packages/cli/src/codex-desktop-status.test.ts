import { describe, expect, it, vi } from "vitest";
import { inspectCodexDesktop } from "./codex-desktop-status.js";

const binary = "/Applications/Codex.app/Contents/MacOS/Codex";
const environment = { CODEX_DESKTOP_APP: "/Applications/Codex.app" };
const base = { executableExists: async () => true };

describe("installed Desktop inspection", () => {
  it("inspects running Desktop activity without requiring an archive capability marker", async () => {
    const execute = vi.fn(async () => ({ stdout: `10 1 ${binary}\n11 10 /codex app-server --stdio\n` }));
    expect(await inspectCodexDesktop(environment, { ...base, execute: execute as never })).toMatchObject({ status: "running", pid: 10, activity: { state: "unknown" } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("reports a missing app and a stopped supported app separately", async () => {
    expect(await inspectCodexDesktop(environment, { ...base, executableExists: async () => false })).toEqual({ status: "not-installed" });
    expect(await inspectCodexDesktop(environment, { ...base, execute: vi.fn(async () => ({ stdout: "" })) as never })).toMatchObject({ status: "stopped" });
  });

  it("does not mistake private stdio or another daemon's empty list for idle", async () => {
    const probe = vi.fn();
    const execute = vi.fn(async () => ({ stdout: `10 1 ${binary}\n11 10 /Applications/Codex.app/Contents/Resources/codex app-server --stdio\n20 1 /managed/codex app-server --listen ws://127.0.0.1:4500\n` }));
    expect(await inspectCodexDesktop({ ...environment, AGENT_CODEX_DESKTOP_WS_URL: "ws://127.0.0.1:4500" }, { ...base, execute: execute as never, probe })).toMatchObject({ status: "running", pid: 10, activity: { state: "unknown" } });
    expect(probe).not.toHaveBeenCalled();
  });

  it("queries only a verified listener belonging to the Desktop child", async () => {
    const execute = vi.fn(async (command) => ({ stdout: command === "/bin/ps"
      ? `10 1 ${binary}\n11 10 /codex app-server --listen ws://0.0.0.0:4500\n`
      : "tIPv4\nn*:4500\n" }));
    const probe = vi.fn(async () => ({ state: "idle" as const }));
    expect(await inspectCodexDesktop(environment, { ...base, execute: execute as never, probe })).toMatchObject({ activity: { state: "idle" } });
    expect(probe).toHaveBeenCalledWith("ws://localhost:4500/");
    expect(execute).toHaveBeenCalledWith("/usr/sbin/lsof", expect.arrayContaining(["-p", "11"]), expect.anything());
  });

  it("requires a named Unix socket, not an anonymous socketpair", async () => {
    const execute = vi.fn(async (command) => ({ stdout: command === "/bin/ps"
      ? `10 1 ${binary}\n11 10 /codex app-server --listen unix:///tmp/desktop.sock\n`
      : "tunix\nn0x123 -> 0x456\nn/tmp/desktop.sock type=STREAM\n" }));
    const probe = vi.fn(async () => ({ state: "busy" as const, activeCount: 2 }));
    expect(await inspectCodexDesktop(environment, { ...base, execute: execute as never, probe })).toMatchObject({ activity: { state: "busy", activeCount: 2 } });
    expect(probe).toHaveBeenCalledWith("ws+unix://localhost/tmp/desktop.sock:/rpc");
  });

  it("keeps missing listener ownership and multiple backends unknown", async () => {
    const probe = vi.fn();
    for (const children of ["11 10 /codex app-server --listen ws://127.0.0.1:4500", "11 10 /codex app-server --stdio\n12 10 /codex app-server --stdio"]) {
      const execute = vi.fn(async (command) => ({ stdout: command === "/bin/ps" ? `10 1 ${binary}\n${children}\n` : "" }));
      expect(await inspectCodexDesktop(environment, { ...base, execute: execute as never, probe })).toMatchObject({ activity: { state: "unknown" } });
    }
    expect(probe).not.toHaveBeenCalled();
  });
});
