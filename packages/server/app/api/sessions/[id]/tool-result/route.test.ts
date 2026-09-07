import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const state = vi.hoisted(() => ({
  getSessionToolResult: vi.fn(),
}));

vi.mock("../../../../../lib/native-runtime-service", () => ({
  getNativeRuntimeService: () => ({ getSessionToolResult: state.getSessionToolResult }),
  isNativeSessionId: (id: string) => id.startsWith("runtime:"),
  runtimeErrorStatus: (error: { code?: string }) => error.code === "STALE_SESSION_ANCHOR" ? 409 : 500,
}));

describe("session tool-result route", () => {
  beforeEach(() => state.getSessionToolResult.mockReset());

  it("rejects incomplete locators before calling the runtime", async () => {
    const response = await GET(
      new Request("http://test/api/sessions/runtime:codex:c2Vzc2lvbg/tool-result?turnId=turn-1"),
      { params: { id: "runtime:codex:c2Vzc2lvbg" } },
    );

    expect(response.status).toBe(400);
    expect(state.getSessionToolResult).not.toHaveBeenCalled();
  });

  it("returns one revision-scoped tool body", async () => {
    const body = {
      turnId: "turn/1",
      itemId: "call 1",
      revision: "rev:1",
      byteSize: 6,
      content: "output",
    };
    state.getSessionToolResult.mockResolvedValue(body);
    const response = await GET(
      new Request("http://test/api/sessions/runtime:codex:c2Vzc2lvbg/tool-result?turnId=turn%2F1&itemId=call+1&revision=rev%3A1"),
      { params: { id: "runtime:codex:c2Vzc2lvbg" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(body);
    expect(state.getSessionToolResult).toHaveBeenCalledWith("runtime:codex:c2Vzc2lvbg", {
      turnId: "turn/1",
      itemId: "call 1",
      revision: "rev:1",
    });
  });

  it("rejects local sessions as unsupported", async () => {
    const response = await GET(
      new Request("http://test/api/sessions/local-1/tool-result?turnId=t&itemId=i&revision=r"),
      { params: { id: "local-1" } },
    );

    expect(response.status).toBe(405);
    expect(state.getSessionToolResult).not.toHaveBeenCalled();
  });
});
