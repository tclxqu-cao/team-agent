import { describe, expect, it, vi } from "vitest";
import { LitePairingService } from "./lite-pairing.js";

function fixture(choices = [{ instanceId: "cli", url: "http://127.0.0.1:4000", dataDir: "/cli/data" }]) {
  const invitation = { svg: "<svg/>", origin: "https://phone.example", pairingUrl: "https://phone.example/pair#pair=grant", expiresAt: Date.now() + 300000 };
  const service = { status: vi.fn().mockResolvedValue({ connected: true, selected: choices[0] ?? null, choices, preferredDataDir: choices[0]?.dataDir ?? null }), select: vi.fn(), mobilePairing: vi.fn().mockResolvedValue(invitation) };
  const bootstrap = { prepare: vi.fn().mockResolvedValue({ phase: "ready", message: "" }) };
  const readOrigin = vi.fn().mockResolvedValue("https://phone.example");
  return { service, bootstrap, readOrigin, invitation, pairing: new LitePairingService(service, bootstrap, readOrigin) };
}
describe("Lite CLI pairing bootstrap", () => {
  it("reuses the phone-ready service without reinstalling or replacing it", async () => {
    const f = fixture();
    expect(await f.pairing.refresh()).toEqual(f.invitation);
    expect(f.bootstrap.prepare).not.toHaveBeenCalled();
    expect(f.service.select).not.toHaveBeenCalled();
  });
  it("selects the CLI service when the connected development server has no tunnel", async () => {
    const f = fixture([{ instanceId: "dev", url: "http://127.0.0.1:3000", dataDir: "/dev" }, { instanceId: "cli", url: "http://127.0.0.1:4000", dataDir: "/cli/data" }]);
    f.readOrigin.mockImplementation(async (dir: string) => { if (dir === "/dev") throw new Error("no tunnel"); return "https://phone.example"; });
    await f.pairing.refresh();
    expect(f.service.select).toHaveBeenCalledWith("cli");
    expect(f.bootstrap.prepare).not.toHaveBeenCalled();
  });
  it("uses the CLI bootstrap for a fresh installation and discovers its service afterwards", async () => {
    const f = fixture();
    f.service.status.mockResolvedValueOnce({ connected: false, selected: null, choices: [], preferredDataDir: null });
    await f.pairing.refresh();
    expect(f.bootstrap.prepare).toHaveBeenCalledOnce();
    expect(f.service.mobilePairing).toHaveBeenCalledOnce();
  });
  it("does not bootstrap or switch services to bypass remote emergency lock", async () => {
    const f = fixture(); f.service.mobilePairing.mockRejectedValue(new Error("远程访问已锁定"));
    await expect(f.pairing.refresh()).rejects.toThrow("远程访问已锁定");
    expect(f.bootstrap.prepare).not.toHaveBeenCalled();
    expect(f.service.select).not.toHaveBeenCalled();
  });
  it("shows preparation failure and allows a later refresh to retry", async () => {
    const f = fixture();
    f.service.status.mockResolvedValueOnce({ connected: false, selected: null, choices: [], preferredDataDir: null });
    f.bootstrap.prepare.mockResolvedValueOnce({ phase: "error", message: "请检查网络" });
    await expect(f.pairing.refresh()).rejects.toThrow("请检查网络");
    await expect(f.pairing.refresh()).resolves.toEqual(f.invitation);
  });
  it("deduplicates concurrent startup requests but mints a fresh invitation on the next refresh", async () => {
    const f = fixture();
    const a = f.pairing.refresh(), b = f.pairing.refresh();
    expect(a).toBe(b); await a;
    await f.pairing.refresh();
    expect(f.service.mobilePairing).toHaveBeenCalledTimes(2);
  });
});
