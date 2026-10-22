import { describe, expect, it, vi } from "vitest";
import { runWindowsCodexDesktop, windowsSharingEndpoint, powershellLiteral } from "./codex-desktop-windows.js";
import { parseArgs } from "./args.js";
const endpoint = "ws://127.0.0.1:45123/";
const binary = "C:\\Program Files\\Codex\\Codex.exe";
function fixture(running = true) {
  const scripts: string[] = [];
  const execute = vi.fn(async (_command: string, args: string[]) => {
    const script = args[args.length - 1]!; scripts.push(script);
    if (script.includes("ReadAllBytes")) return { stdout: "supported", stderr: "" };
    if (script.includes("Select-Object ProcessId")) return { stdout: running ? JSON.stringify([{ ProcessId: 123, CreationDate: "2026-10-22T10:00:00.0000000+08:00", ExecutablePath: binary }]) : "[]", stderr: "" };
    if (script.includes("GetEnvironmentVariable")) return { stdout: endpoint, stderr: "" };
    if (script.includes("Get-NetTCPConnection")) return { stdout: "0", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  return { scripts, context: { environment: { AGENT_CODEX_DESKTOP_WS_URL: endpoint, CODEX_DESKTOP_APP: binary }, execute: execute as never, probe: vi.fn(async () => {}), log: vi.fn() } };
}
describe("Windows Codex sharing", () => {
  it("status without config is read-only", async () => {
    const f = fixture();
    const report = await runWindowsCodexDesktop(parseArgs(["codex-desktop", "--status"]), { ...f.context, environment: {}, readBackend: async () => null });
    expect(report.state).toBe("failed"); expect(f.scripts).toEqual([]);
  });
  it("automatically provisions backend and discovers Desktop without manual environment", async () => {
    const f = fixture(false);
    const backend = vi.fn(async () => ({ version: 1 as const, endpoint, executable: binary, codexHome: "C:\\Users\\test\\.codex" }));
    const execute = vi.fn(async (command: string, args: string[], opts: unknown) => {
      if (args.at(-1)!.includes("$candidates=@()")) return { stdout: binary, stderr: "" };
      return (f.context.execute as (...args: unknown[]) => Promise<{ stdout: string; stderr: string }>)(command, args, opts);
    });
    const report = await runWindowsCodexDesktop(parseArgs(["codex-desktop", "--setup"]), { ...f.context, environment: {}, backend, execute: execute as never });
    expect(backend).toHaveBeenCalledOnce(); expect(report.state).toBe("stopped");
    expect(f.scripts.join("\n")).not.toMatch(/Stop-Process|Start-Process/);
  });
  it.each(["ws://external.example:1234", "wss://localhost:1234", "ws://user:pass@localhost:1234"])("rejects unsafe endpoint %s", value => {
    expect(() => windowsSharingEndpoint({ CODEX_APP_SERVER_WS_URL: value })).toThrow();
  });
  it("escapes PowerShell literals", () => { expect(powershellLiteral("C:\\O'Brien")).toBe("'C:\\O''Brien'"); });
  it("status is read-only and never invokes macOS tools", async () => {
    const f = fixture(); await runWindowsCodexDesktop(parseArgs(["codex-desktop", "--status"]), f.context);
    expect(f.scripts.join("\n")).not.toMatch(/Stop-Process|SetEnvironmentVariable|Start-Process|launchctl|osascript/);
  });
  it("prepares a stopped Desktop without opening it", async () => {
    const f = fixture(false); await runWindowsCodexDesktop(parseArgs(["codex-desktop", "--setup"]), f.context);
    expect(f.scripts.join("\n")).toContain("SetEnvironmentVariable");
    expect(f.scripts.join("\n")).not.toMatch(/Stop-Process|Start-Process/);
  });
  it("requires consent when activity is unknown", async () => {
    const f = fixture(); await expect(runWindowsCodexDesktop(parseArgs(["codex-desktop"]), f.context)).rejects.toThrow("确认");
    expect(f.scripts.join("\n")).not.toContain("Stop-Process");
  });
  it("only force stops the identified PID after explicit consent and never claims launch is sharing", async () => {
    const f = fixture(); const report = await runWindowsCodexDesktop(parseArgs(["codex-desktop", "--restart"]), f.context);
    const scripts = f.scripts.join("\n");
    expect(scripts).toContain("Stop-Process -Id 123 -Force"); expect(scripts).toContain("CreationDate.ToString('o')");
    expect(scripts).not.toContain("taskkill"); expect(scripts).not.toContain("-Name codex"); expect(report.state).toBe("failed");
  });
  it("never stops Desktop if backend probing fails", async () => {
    const f = fixture(); f.context.probe.mockRejectedValue(new Error("offline"));
    await expect(runWindowsCodexDesktop(parseArgs(["codex-desktop", "--restart"]), f.context)).rejects.toThrow("offline");
    expect(f.scripts.join("\n")).not.toContain("Stop-Process");
  });
});
