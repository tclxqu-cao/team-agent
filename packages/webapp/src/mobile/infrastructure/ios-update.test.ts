import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IosUpdateService } from "./ios-update";

const { getInfo, openStore, get } = vi.hoisted(() => ({ getInfo: vi.fn(), openStore: vi.fn(), get: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  registerPlugin: () => ({ getInfo, openStore }),
  CapacitorHttp: { get },
}));

const bundleId = "com.agentroam.mobile";
const listing = { bundleId, trackId: 1234567890, version: "1.1" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  getInfo.mockResolvedValue({ bundleId, version: "1.0", country: "cn" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("iOS App Store updates", () => {
  it("checks asynchronously and only opens the matched App Store listing on confirmation", async () => {
    get.mockResolvedValue({ status: 200, data: { results: [{ ...listing, bundleId: "unrelated" }, listing] } });
    const service = new IosUpdateService();
    const notified = vi.fn();
    service.onUpdateStatus(notified);
    await expect(service.getUpdateStatus()).resolves.toMatchObject({ phase: "idle" });
    expect(get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(notified).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "available", currentVersion: "1.0.0", targetVersion: "1.1.0" }));
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ params: { bundleId, country: "cn", entity: "software" } }));
    expect(openStore).not.toHaveBeenCalled();
    await expect(service.installUpdate()).resolves.toMatchObject({ phase: "available", targetVersion: "1.1.0" });
    expect(openStore).toHaveBeenCalledWith({ id: "1234567890" });
  });

  it("rechecks on demand and reports a missing listing without offering an install", async () => {
    get.mockResolvedValueOnce({ status: 200, data: { results: [] } })
      .mockResolvedValueOnce({ status: 200, data: { results: [{ ...listing, version: "1.0.0" }] } });
    const service = new IosUpdateService();
    await expect(service.checkForUpdate()).resolves.toMatchObject({ phase: "unavailable", message: expect.stringContaining("原安装渠道") });
    await expect(service.installUpdate()).rejects.toThrow("当前没有");
    await expect(service.checkForUpdate()).resolves.toMatchObject({ phase: "up-to-date", currentVersion: "1.0.0" });
    expect(get).toHaveBeenCalledTimes(2);
    expect(openStore).not.toHaveBeenCalled();
  });
});
