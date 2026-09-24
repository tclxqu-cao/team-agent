import { describe, expect, it, vi } from "vitest";
import { createElectronFileWorkspaceGateway } from "./electron-file-workspace-gateway";

describe("createElectronFileWorkspaceGateway", () => {
  it("maps requests and subscriptions to the preload API", async () => {
    const unsubscribe = vi.fn();
    const request = vi.fn(async () => ({ home: "/work" }));
    const subscribe = vi.fn(() => unsubscribe);
    const gateway = createElectronFileWorkspaceGateway({
      fileWorkspaceRequest: request,
      onFileWorkspaceEvent: subscribe,
    });
    const listener = vi.fn();

    await expect(gateway.request("hello")).resolves.toEqual({ home: "/work" });
    const off = gateway.subscribe("fs:event", listener);

    expect(request).toHaveBeenCalledWith("hello", undefined);
    expect(subscribe).toHaveBeenCalledWith(listener);
    off();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
