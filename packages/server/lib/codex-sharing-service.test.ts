import { describe, expect, it, vi } from "vitest";
import { combineSharingStatus, switchCodexSharing, type SharingReport } from "./codex-sharing-service";
const shared: SharingReport = { state: "shared", configured: true, autoStart: true, daemonReachable: true, message: "已连接" };
describe("combined Desktop and AgentRoam sharing", () => {
  it("does not label a standalone gateway as shared even if Desktop is shared", () => {
    expect(combineSharingStatus(shared, "standalone")).toMatchObject({ state: "independent", runtimeMode: "standalone" });
  });
  it("does not label a disconnected gateway as shared", () => {
    expect(combineSharingStatus(shared, null).state).toBe("failed");
  });
  it("preserves actual private Desktop evidence when gateway uses the daemon", () => {
    expect(combineSharingStatus({ ...shared, state: "independent" }, "shared").state).toBe("independent");
  });
  it("verifies the actual Desktop transport target and omits private endpoint details", () => {
    const desktop = { ...shared, backendEndpoint: "ws+unix://localhost/home/shared.sock:/rpc" };
    expect(combineSharingStatus(desktop, "desktop", "ws://localhost:1234").state).toBe("failed");
    const result = combineSharingStatus(desktop, "desktop", desktop.backendEndpoint);
    expect(result.state).toBe("shared");
    expect(result).not.toHaveProperty("backendEndpoint");
  });
  it("reports sharing only when both processes have a shared connection", () => {
    expect(combineSharingStatus(shared, "shared").state).toBe("shared");
  });
});

describe("manual sharing fallback", () => {
  it("refuses to restart without explicit confirmation", async () => {
    const launch = vi.fn();
    await expect(switchCodexSharing(false, { read: vi.fn().mockResolvedValue({ ...shared, state: "independent" }), launch })).rejects.toThrow("需要确认");
    expect(launch).not.toHaveBeenCalled();
  });
  it("starts a stopped Desktop without restart and waits for real sharing", async () => {
    const launch = vi.fn(async () => {});
    const read = vi.fn().mockResolvedValueOnce({ ...shared, state: "stopped" }).mockResolvedValueOnce({ ...shared, state: "stopped" }).mockResolvedValue(shared);
    const wait = vi.fn(async () => {});
    await expect(switchCodexSharing(false, { read, launch, wait })).resolves.toMatchObject({ state: "shared" });
    expect(launch).toHaveBeenCalledWith(false); expect(wait).toHaveBeenCalledOnce();
  });
  it("restarts only after confirmation and does not claim success on launch alone", async () => {
    const launch = vi.fn(async () => {});
    await expect(switchCodexSharing(true, { read: vi.fn().mockResolvedValue({ ...shared, state: "independent" }), launch, wait: async () => {} })).rejects.toThrow("尚未验证");
    expect(launch).toHaveBeenCalledWith(true);
  });
  it("does nothing when Desktop already shares the backend", async () => {
    const launch = vi.fn();
    await switchCodexSharing(true, { read: vi.fn().mockResolvedValue(shared), launch });
    expect(launch).not.toHaveBeenCalled();
  });
  it("preserves launch failures rather than retrying a restart", async () => {
    const launch = vi.fn().mockRejectedValue(new Error("Desktop did not exit"));
    await expect(switchCodexSharing(true, { read: vi.fn().mockResolvedValue({ ...shared, state: "independent" }), launch })).rejects.toThrow("Desktop did not exit");
    expect(launch).toHaveBeenCalledOnce();
  });
  it("rejects overlapping switch requests", async () => {
    let finish!: (value: SharingReport) => void;
    const pending = switchCodexSharing(false, { read: () => new Promise(resolve => { finish = resolve; }) });
    await expect(switchCodexSharing(true)).rejects.toThrow("正在切换");
    finish(shared);
    await pending;
  });
});
