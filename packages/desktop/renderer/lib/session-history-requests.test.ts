import { describe, expect, it } from "vitest";
import { SessionHistoryRequests } from "./session-history-requests";

describe("history requests around local submissions", () => {
  it("rejects a snapshot started before admission even after history confirms the input", () => {
    const requests = new SessionHistoryRequests();
    const oldSnapshot = requests.capture("zcode");
    requests.invalidate("zcode");
    const confirmingSnapshot = requests.capture("zcode");
    expect(confirmingSnapshot()).toBe(true);
    expect(oldSnapshot()).toBe(false);
    requests.invalidate("zcode");
    expect(confirmingSnapshot()).toBe(false);
  });

  it("keeps unrelated session reads current", () => {
    const requests = new SessionHistoryRequests();
    const otherSession = requests.capture("other");
    requests.invalidate("zcode");
    expect(otherSession()).toBe(true);
    expect(requests.capture("zcode")()).toBe(true);
  });
});
