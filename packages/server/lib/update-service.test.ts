import { describe, expect, it, vi } from "vitest";
import { ServerUpdateService } from "./update-service";

describe("ServerUpdateService", () => {
  it("returns cached status without refreshing", async () => {
    const checker = { schedule: vi.fn(), getStatus: vi.fn(() => ({ phase: "idle", currentVersion: "1.0.0" })), refresh: vi.fn() } as any;
    const service = new ServerUpdateService({ currentVersion: "1.0.0", platform: "darwin-arm64", checker });
    await expect(service.status()).resolves.toMatchObject({ phase: "idle" });
    expect(checker.refresh).not.toHaveBeenCalled();
  });

  it("starts a check without awaiting it", () => {
    let phase = "idle";
    const checker = {
      schedule: vi.fn(),
      getStatus: vi.fn(() => ({ phase, currentVersion: "1.0.0" })),
      refresh: vi.fn(() => {
        phase = "checking";
        return new Promise(() => {});
      }),
    } as any;
    const service = new ServerUpdateService({ currentVersion: "1.0.0", platform: "darwin-arm64", checker });
    expect(service.requestCheck()).toMatchObject({ phase: "checking" });
    expect(checker.refresh).toHaveBeenCalledOnce();
  });

  it("refuses install outside a packaged service", async () => {
    const service = new ServerUpdateService({ currentVersion: "1.0.0", platform: null });
    await expect(service.installAvailable()).rejects.toThrow("packaged AgentRoam service");
  });
});
