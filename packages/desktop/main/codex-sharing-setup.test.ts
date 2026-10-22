import { describe, expect, it, vi } from "vitest";
import { DesktopCodexSharingSetup } from "./codex-sharing-setup";
function fixture(states: string[]) {
  const request = vi.fn(async (_body: string) => {
    const state = states.shift();
    return { status: 200, body: JSON.stringify({ state, confirmationRequired: state === "independent" }) };
  });
  const confirm = vi.fn(async () => false), report = vi.fn();
  return { request, confirm, report, setup: new DesktopCodexSharingSetup({ request, confirm, report }) };
}
describe("desktop sharing setup", () => {
  it.each(["shared", "stopped", "not-installed", "unsupported"])("does not ask or open Desktop for %s", async state => {
    const f = fixture([state]); await f.setup.prepare(); await f.setup.prepare();
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledOnce();
  });
  it("preserves an occupied Desktop when consent is declined", async () => {
    const f = fixture(["independent"]); await f.setup.prepare();
    expect(f.confirm).toHaveBeenCalledOnce(); expect(f.request).toHaveBeenCalledOnce();
  });
  it("passes confirmed force restart to the same backend used by phone", async () => {
    const f = fixture(["independent", "shared"]); f.confirm.mockResolvedValue(true);
    await f.setup.prepare();
    expect(JSON.parse(f.request.mock.calls[1][0]!)).toEqual({ action: "share", restartConfirmed: true });
  });
  it("reports failure without preventing phone pairing and allows retry", async () => {
    const f = fixture(["shared"]); f.request.mockRejectedValueOnce(new Error("offline"));
    await expect(f.setup.prepare()).resolves.toBeUndefined(); expect(f.report).toHaveBeenCalledWith("offline");
    await f.setup.prepare(); expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("never infers restart consent requirements from a failed preparation state", async () => {
    const f = fixture([]);
    f.request.mockResolvedValue({ status: 200, body: JSON.stringify({ state: "failed", message: "backend unavailable" }) });
    await f.setup.prepare();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenCalledWith("backend unavailable");
  });
});
