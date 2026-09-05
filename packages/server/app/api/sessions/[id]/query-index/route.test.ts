import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const state = vi.hoisted(() => ({
  nativeIndex: {
    sessionId: "runtime:codex:bW9jaw",
    revision: "native-rev",
    totalQueries: 1,
    entries: [{ messageId: "native-m1", ordinal: 1, preview: "native", pageToken: "native-a1" }],
  },
}));

vi.mock("../../../agent-host", () => ({
  agentHost: {
    getSessionStore: () => ({
      get: async (id: string) => id === "local-1" ? {
        id,
        messages: [
          { role: "user", content: "first query" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "second query" },
        ],
        events: [],
      } : null,
    }),
  },
}));

vi.mock("../../../../../lib/native-runtime-service", () => ({
  getNativeRuntimeService: () => ({ getQueryIndex: async () => state.nativeIndex }),
  isNativeSessionId: (id: string) => id.startsWith("runtime:"),
  runtimeErrorStatus: () => 500,
}));

describe("session query-index route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only compact navigation data for a local session", async () => {
    const response = await GET(new Request("http://test/api/sessions/local-1/query-index"), {
      params: { id: "local-1" },
    });
    const result = await response.json();

    expect(response.status).toBe(200);
    expect(result.totalQueries).toBe(2);
    expect(result.entries.map((entry: Record<string, unknown>) => Object.keys(entry).sort())).toEqual([
      ["messageId", "ordinal", "pageToken", "preview"],
      ["messageId", "ordinal", "pageToken", "preview"],
    ]);
    expect(JSON.stringify(result)).not.toContain("answer");
  });

  it("uses the native host index contract", async () => {
    const response = await GET(new Request("http://test/api/sessions/runtime:codex:bW9jaw/query-index"), {
      params: { id: "runtime:codex:bW9jaw" },
    });
    await expect(response.json()).resolves.toEqual(state.nativeIndex);
  });

  it("returns 404 for a missing local session", async () => {
    const response = await GET(new Request("http://test/api/sessions/missing/query-index"), {
      params: { id: "missing" },
    });
    expect(response.status).toBe(404);
  });
});
