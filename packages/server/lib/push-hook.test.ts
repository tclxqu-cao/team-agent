import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  warn: vi.fn(),
  load: vi.fn(() => { throw new Error("push dependency unavailable"); }),
}));
vi.mock("../app/api/agent-host", () => ({ agentHost: { setGlobalEventObserver: mocks.register } }));
vi.mock("./global-logger", () => ({ serverLogger: () => ({ warn: mocks.warn }) }));
vi.mock("./shared-settings", () => ({ sharedSettings: vi.fn() }));
vi.mock("./web-push-service.mjs", () => { mocks.load(); return {}; });

import { ensurePushHook } from "./push-hook";

describe("optional push dependency isolation", () => {
  it("registers without loading push and catches a later module failure", async () => {
    ensurePushHook();
    expect(mocks.load).not.toHaveBeenCalled();
    const observer = mocks.register.mock.calls[0][0];
    await expect(observer("test", { type: "error", message: "test" }, { source: "user" })).resolves.toBeUndefined();
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.warn).toHaveBeenCalledWith("web push notify failed", expect.objectContaining({ sessionId: "test" }));
  });
});
