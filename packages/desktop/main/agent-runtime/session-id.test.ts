import { describe, expect, it } from "vitest";
import { decodeUnifiedSessionId, encodeUnifiedSessionId } from "./session-id.js";

describe("unified session IDs", () => {
  it.each(["customer-agent", "codex", "claude-code"] as const)(
    "round trips %s IDs",
    (agentType) => {
      const nativeSessionId = "会话/id:with punctuation";
      expect(decodeUnifiedSessionId(encodeUnifiedSessionId(agentType, nativeSessionId))).toEqual({
        agentType,
        nativeSessionId,
      });
    },
  );

  it("treats an unprefixed ID as a legacy Customer Agent session", () => {
    expect(decodeUnifiedSessionId("19d9d926-4ef9-46ed-8fa6-31f498a327ae")).toEqual({
      agentType: "customer-agent",
      nativeSessionId: "19d9d926-4ef9-46ed-8fa6-31f498a327ae",
    });
  });

  it.each([
    "",
    "runtime:unknown:c2Vzc2lvbg",
    "runtime:codex:",
    "runtime:codex:%%%",
  ])("rejects malformed ID %j", (id) => {
    expect(() => decodeUnifiedSessionId(id)).toThrow(/session id/i);
  });

  it("rejects an empty native ID", () => {
    expect(() => encodeUnifiedSessionId("codex", "")).toThrow(/required/i);
  });
});
