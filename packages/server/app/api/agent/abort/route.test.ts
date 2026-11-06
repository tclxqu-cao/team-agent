import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ native: vi.fn(), customer: vi.fn(), stopGoal: vi.fn(), log: vi.fn() }));
vi.mock("../../agent-host", () => ({ agentHost: { abort: calls.customer } }));
vi.mock("../../../../lib/native-runtime-service", () => ({
  getNativeRuntimeService: () => ({ abort: calls.native }),
  isNativeSessionId: (id: string) => id.startsWith("runtime:"),
  runtimeErrorStatus: (error: { code?: string }) => error.code === "STALE_SESSION_ANCHOR" ? 409 : 500,
}));
vi.mock("../../../../lib/thread-goal-service", () => ({ getThreadGoalService: () => ({ requestStop: calls.stopGoal }) }));
vi.mock("../../../../lib/global-logger", () => ({ serverLogger: () => ({ info: calls.log }) }));
import { POST } from "./route";

describe("stop request routing", () => {
  beforeEach(() => { vi.resetAllMocks(); });
  const request = (body: unknown) => new Request("http://test/api/agent/abort", {
    method: "POST", headers: { "content-type": "application/json", "user-agent": "fixture-browser" }, body: JSON.stringify(body),
  });

  it("forwards the observed run and records the keyboard trigger without stopping another runtime", async () => {
    const sessionId = "runtime:zcode:c2Vzc19h";
    expect((await POST(request({ sessionId, expectedRunId: "run-a", trigger: "keyboard" }))).status).toBe(200);
    expect(calls.native).toHaveBeenCalledWith(sessionId, { expectedRunId: "run-a", source: "web", trigger: "keyboard" });
    expect(calls.customer).not.toHaveBeenCalled();
    expect(calls.log).toHaveBeenCalledWith("agent stop requested", expect.objectContaining({
      sessionId, expectedRunId: "run-a", trigger: "keyboard", userAgent: "fixture-browser",
    }));
  });

  it("returns a conflict when the old stop would target a newer turn", async () => {
    calls.native.mockRejectedValue(Object.assign(new Error("new turn is active"), { code: "STALE_SESSION_ANCHOR" }));
    const response = await POST(request({ sessionId: "runtime:zcode:c2Vzc19h", expectedRunId: "old-run" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "new turn is active" });
  });

  it.each([null, [], { sessionId: 4 }, { expectedRunId: {} }])("rejects malformed stop targets: %j", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(calls.native).not.toHaveBeenCalled();
    expect(calls.customer).not.toHaveBeenCalled();
  });

  it("retains the existing customer-agent stop without a request body", async () => {
    expect((await POST(new Request("http://test/api/agent/abort", { method: "POST" }))).status).toBe(200);
    expect(calls.customer).toHaveBeenCalledWith(undefined);
    expect(calls.native).not.toHaveBeenCalled();
  });
});
