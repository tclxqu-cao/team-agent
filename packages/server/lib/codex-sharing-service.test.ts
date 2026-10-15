import { describe, expect, it } from "vitest";
import { combineSharingStatus, type SharingReport } from "./codex-sharing-service";
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
