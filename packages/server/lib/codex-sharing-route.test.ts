import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), health: vi.fn(), share: vi.fn(), prepare: vi.fn() }));
vi.mock("./codex-sharing-service", async importOriginal => ({ ...await importOriginal<typeof import("./codex-sharing-service")>(), readCodexSharing: mocks.read, switchCodexSharing: mocks.share, prepareCodexSharing: mocks.prepare }));
vi.mock("./native-runtime-service", () => ({ getNativeRuntimeService: () => ({ health: mocks.health }) }));
import { GET, POST } from "../app/api/agent/codex-sharing/route";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
function ready() {
  mocks.read.mockResolvedValue({ state: "shared", configured: true, autoStart: true, daemonReachable: true, message: "已共享" });
  mocks.health.mockResolvedValue([{ agentType: "codex", connectionMode: "shared" }]);
}
describe("Codex sharing management route", () => {
  it("returns no-store status without repairing", async () => {
    ready(); const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ state: "shared" });
    expect(mocks.read).toHaveBeenCalledWith(false);
  });
  it("rejects foreign browser writes before invoking CLI management", async () => {
    const response = await POST(new Request("http://localhost:3000/api/agent/codex-sharing", { method: "POST", headers: { origin: "https://foreign.example", host: "localhost:3000" } }));
    expect(response.status).toBe(403); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("accepts the LAN host forwarded by Next", async () => {
    ready(); const response = await POST(new Request("http://localhost:3000/api/agent/codex-sharing", { method: "POST", headers: { origin: "http://100.121.10.115:3000", host: "100.121.10.115:3000" } }));
    expect(response.status).toBe(200); expect(mocks.read).toHaveBeenCalledWith(true);
  });
  it.each([true, false])("honors the explicit tunnel trust setting: %s", async trusted => {
    ready(); vi.stubEnv("AGENT_TRUST_TUNNEL_PROXY", trusted ? "1" : "0");
    const response = await POST(new Request("http://localhost:3000/api/agent/codex-sharing", { method: "POST", headers: { origin: "https://current.trycloudflare.com", host: "current.trycloudflare.com", "x-forwarded-proto": "https" } }));
    expect(response.status).toBe(trusted ? 200 : 403);
    if (!trusted) expect(mocks.read).not.toHaveBeenCalled();
  });
  it("reports CLI failure explicitly", async () => {
    ready(); mocks.read.mockRejectedValue(new Error("unavailable"));
    const response = await GET(); expect(response.status).toBe(503);
    expect(await response.json()).toHaveProperty("error.message");
  });
  it("passes explicit restart consent to sharing and returns verified combined status", async () => {
    ready(); mocks.share.mockResolvedValue({ state: "shared" });
    const response = await POST(new Request("http://localhost:3000/api/agent/codex-sharing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "share", restartConfirmed: true }) }));
    expect(response.status).toBe(200); expect(mocks.share).toHaveBeenCalledWith(true);
    expect(await response.json()).toMatchObject({ state: "shared" });
  });
  it("rejects invalid action bodies without launching Desktop", async () => {
    const response = await POST(new Request("http://localhost:3000/api/agent/codex-sharing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "share" }) }));
    expect(response.status).toBe(400); expect(mocks.share).not.toHaveBeenCalled();
  });
  it("uses noninteractive installation rules for desktop preparation without claiming consent", async () => {
    ready(); mocks.prepare.mockResolvedValue({ state: "independent", confirmationRequired: true });
    const response = await POST(new Request("http://localhost:3000/api/agent/codex-sharing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "prepare" }) }));
    expect(response.status).toBe(200); expect(mocks.prepare).toHaveBeenCalledOnce(); expect(mocks.share).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ state: "independent", confirmationRequired: true });
  });
});
