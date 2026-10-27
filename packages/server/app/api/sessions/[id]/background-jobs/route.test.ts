import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeSessionError } from "@agent/native-runtime";
import { GET } from "./route";
import { GET as output } from "./[jobId]/route";
import { POST as stop } from "./[jobId]/stop/route";

const state = vi.hoisted(() => ({ list: vi.fn(), output: vi.fn(), stop: vi.fn() }));
vi.mock("../../../../../lib/native-runtime-service", async () => {
  const original = await vi.importActual<typeof import("../../../../../lib/native-runtime-service")>("../../../../../lib/native-runtime-service");
  return { getNativeRuntimeService: () => ({ listBackgroundJobs: state.list, getBackgroundJobOutput: state.output, stopBackgroundJob: state.stop }),
    isNativeSessionId: (id: string) => id.startsWith("runtime:"), runtimeErrorStatus: original.runtimeErrorStatus };
});
beforeEach(() => {
  state.list.mockReset().mockResolvedValue([]);
  state.output.mockReset().mockResolvedValue({ job: { id: "bash-1", status: "running" }, output: "", truncated: false });
  state.stop.mockReset().mockResolvedValue({ outcome: "requested" });
});
const context = { params: { id: "runtime:deepseek-harness:bmF0aXZl", jobId: "bash-1" } };
const request = new Request("http://test/background-jobs");

describe("background task HTTP boundary", () => {
  it("keeps roster reads, output reads and human stop separate", async () => {
    expect(await (await GET(request, context)).json()).toEqual({ jobs: [] });
    expect(await (await output(request, context)).json()).toMatchObject({ output: "", job: { status: "running" } });
    expect(state.stop).not.toHaveBeenCalled();
    expect(await (await stop(request, context)).json()).toEqual({ outcome: "requested" });
    expect(state.stop).toHaveBeenCalledWith(context.params.id, "bash-1");
  });

  it("rejects non-native sessions before reaching the runtime", async () => {
    const invalid = { params: { id: "local-session", jobId: "bash-1" } };
    expect((await GET(request, invalid)).status).toBe(400);
    expect((await output(request, invalid)).status).toBe(400);
    expect((await stop(request, invalid)).status).toBe(400);
    expect(state.list).not.toHaveBeenCalled(); expect(state.output).not.toHaveBeenCalled(); expect(state.stop).not.toHaveBeenCalled();
  });

  it("returns missing and unavailable task failures without reporting success", async () => {
    state.stop.mockRejectedValue(new RuntimeSessionError("Task not visible", "BACKGROUND_JOB_NOT_FOUND"));
    expect((await stop(request, context)).status).toBe(404);
    state.output.mockRejectedValue(new RuntimeSessionError("Host unavailable", "RUNTIME_UNAVAILABLE"));
    expect((await output(request, context)).status).toBe(503);
  });
});
