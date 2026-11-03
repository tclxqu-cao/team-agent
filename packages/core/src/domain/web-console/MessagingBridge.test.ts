import { describe, expect, it } from "vitest";
import { MESSAGING_OPEN, MESSAGING_READY, readMessagingOpen } from "./MessagingBridge";

describe("messaging tab navigation", () => {
  const source = {} as MessageEventSource;
  const origin = "https://agent.test";
  const event = { data: { type: MESSAGING_OPEN }, source, origin };

  it("accepts the assistant frame's request to open a shell tab", () => {
    expect(readMessagingOpen(event, origin, source)).toBe(true);
  });

  it("rejects other frames, origins, readiness events and malformed payloads", () => {
    expect(readMessagingOpen(event, "https://untrusted.test", source)).toBe(false);
    expect(readMessagingOpen(event, origin, {} as MessageEventSource)).toBe(false);
    expect(readMessagingOpen({ ...event, source: null }, origin, null)).toBe(false);
    for (const data of [null, [], "messaging", { type: MESSAGING_READY }, {}]) {
      expect(readMessagingOpen({ ...event, data }, origin, source)).toBe(false);
    }
  });
});
