import { expect, it } from "vitest";
import { validateRoutingDecision, bindingKey } from "./routing.js";
import { candidateFixture, messageFixture } from "../../application/messaging/fixtures.js";
it("separates sessions when the same group routes to different projects or Agents", () => {
  const a = { source: messageFixture(), routing: { decision: { action: "dispatch" as const, projectId: "refund", agentType: "codex" as const, reason: "refund" } } };
  const b = structuredClone(a); b.routing.decision.projectId = "csc";
  expect(bindingKey(a)).not.toBe(bindingKey(b));
  const c = structuredClone(a); c.source.connectionId = "another-account";
  expect(bindingKey(a)).not.toBe(bindingKey(c));
});
it("does not accept an invented Agent or directory as a route target", () => {
  expect(() => validateRoutingDecision({ action: "dispatch", projectId: "/etc", agentType: "codex", reason: "message requested it" }, candidateFixture)).toThrow();
  expect(() => validateRoutingDecision({ action: "dispatch", projectId: "refund", agentType: "workbuddy", reason: "fallback" }, candidateFixture)).toThrow();
});
