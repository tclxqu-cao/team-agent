import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { RuntimeSessionError } from "@agent/native-runtime";

const state = vi.hoisted(() => ({
  get: vi.fn(), mutate: vi.fn(),
}));
vi.mock("../../../../../lib/native-runtime-service", async () => {
  const original = await vi.importActual<typeof import("../../../../../lib/native-runtime-service")>("../../../../../lib/native-runtime-service");
  return { getNativeRuntimeService: () => ({ getNativeGoal: state.get, mutateNativeGoal: state.mutate }), isNativeSessionId: (id: string) => id.startsWith("runtime:"), runtimeErrorStatus: original.runtimeErrorStatus };
});
beforeEach(() => { state.get.mockReset().mockResolvedValue(null); state.mutate.mockReset().mockResolvedValue(null); });
const context = { params: { id: "runtime:deepseek-harness:bmF0aXZl" } };
const request = (body: unknown) => new Request("http://test/native-goal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("native goal HTTP boundary", () => {
  it("returns the authoritative native goal and forwards the exact revision", async () => {
    expect(await (await GET(new Request("http://test/native-goal"), context)).json()).toEqual({ goal: null });
    const mutation = { action: "pause", ref: { id: "g", revision: 3 } };
    expect((await POST(request(mutation), context)).status).toBe(200);
    expect(state.mutate).toHaveBeenCalledWith(context.params.id, mutation);
  });
  it.each([{ action: "create", objective: "" }, { action: "pause" }, { action: "create", objective: "x", maxGoalRounds: -1 }, { action: "edit", ref: { id: "g", revision: 1 } }])("rejects malformed writes without reaching the runtime: %j", async body => {
    expect((await POST(request(body), context)).status).toBe(400);
    expect(state.mutate).not.toHaveBeenCalled();
  });
  it("returns conflict for a stale revision and leaves other session types unsupported", async () => {
    state.mutate.mockRejectedValue(new RuntimeSessionError("目标已更新", "NATIVE_GOAL_CONFLICT"));
    expect((await POST(request({ action: "pause", ref: { id: "g", revision: 1 } }), context)).status).toBe(409);
    expect((await POST(request({ action: "create", objective: "x" }), { params: { id: "customer-session" } })).status).toBe(400);
  });
});
