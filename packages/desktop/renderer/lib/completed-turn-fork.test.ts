import { describe, expect, it } from "vitest";
import { completedTurnForkPoint } from "./completed-turn-fork";

describe("completed turn fork coordinates", () => {
  it("uses a native point instead of a local renderer ID", () => {
    expect(completedTurnForkPoint({ id: "local-random", role: "assistant", content: "done", presentation: { forkPoint: { turnId: "turn-2" } } }, "runtime:codex:c29tZQ")).toEqual({ turnId: "turn-2" });
  });
  it("uses persisted history IDs for Customer Agent and waits to synchronize random IDs", () => {
    expect(completedTurnForkPoint({ id: "history-message.v1.4.hash", role: "assistant", content: "done" }, "customer-session")).toEqual({ messageId: "history-message.v1.4.hash" });
    expect(completedTurnForkPoint({ id: "random", role: "assistant", content: "done" }, "customer-session")).toBeUndefined();
  });
});
