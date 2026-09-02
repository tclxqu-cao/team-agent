import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const state = vi.hoisted(() => ({
  watchPath: "/tmp/native-session.jsonl" as string | null,
  subscriber: null as null | ((change: { type: "session_history_changed"; revision: number }) => void),
  unsubscribes: 0,
}));

vi.mock("../../../../../lib/native-runtime-service", () => ({
  getNativeRuntimeService: () => ({
    getSessionWatchPath: async () => state.watchPath,
  }),
  isNativeSessionId: (id: string) => id.startsWith("runtime:codex:"),
  runtimeErrorStatus: () => 500,
}));

vi.mock("../../../../../lib/native-session-change-monitor", () => ({
  getNativeSessionChangeMonitor: () => ({
    subscribe: (
      _id: string,
      _path: string,
      subscriber: (change: { type: "session_history_changed"; revision: number }) => void,
    ) => {
      state.subscriber = subscriber;
      return () => {
        state.unsubscribes += 1;
        state.subscriber = null;
      };
    },
  }),
}));

beforeEach(() => {
  state.watchPath = "/tmp/native-session.jsonl";
  state.subscriber = null;
  state.unsubscribes = 0;
});

describe("native session changes route", () => {
  it("streams transcript revision signals and releases the subscription", async () => {
    const abortController = new AbortController();
    const response = await GET(new Request(
      "http://test/api/sessions/runtime:codex:bW9jaw/changes",
      { signal: abortController.signal },
    ), { params: { id: "runtime:codex:bW9jaw" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");

    state.subscriber?.({ type: "session_history_changed", revision: 3 });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      '"type":"session_history_changed","revision":3',
    );

    abortController.abort();
    await reader.cancel();
    expect(state.unsubscribes).toBe(1);
  });

  it("returns 404 when the transcript is unavailable", async () => {
    state.watchPath = null;
    const response = await GET(new Request(
      "http://test/api/sessions/runtime:codex:bW9jaw/changes",
    ), { params: { id: "runtime:codex:bW9jaw" } });

    expect(response.status).toBe(404);
  });
});
