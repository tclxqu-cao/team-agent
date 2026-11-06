import { expect, it } from "vitest";
import { validateRoutingDecision, bindingKey, canResolveMessageTarget } from "./routing.js";
import type { MessageRecord } from "./types.js";
import { candidateFixture, messageFixture } from "../testing/fixtures.js";
it("allows manual retry only for a failed dispatch with no execution receipt", () => {
  const failed: Pick<MessageRecord, "routing" | "execution"> = {
    routing: { status: "routed", mode: "model", decision: { action: "dispatch", reason: "target" } },
    execution: { status: "failed", lastSequence: 0 },
  };
  expect(canResolveMessageTarget(failed)).toBe(true);
  for (const receipt of [{ sessionId: "session" }, { queueItemId: "queue" }, { runId: "run" }, { lastSequence: 1 }]) {
    expect(canResolveMessageTarget({ ...failed, execution: { ...failed.execution, ...receipt } })).toBe(false);
  }
  expect(canResolveMessageTarget({ ...failed, routing: { ...failed.routing, decision: { action: "reply", reason: "chat" } } })).toBe(false);
});
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
it("validates conversational replies without requiring a project and discards injected execution targets", () => {
  expect(validateRoutingDecision({ action: "reply", reason: "私聊教学", knowledgeQuery: "AgentRoam", projectId: "/etc", agentType: "codex" }, []))
    .toEqual({ action: "reply", reason: "私聊教学", knowledgeQuery: "AgentRoam", model: undefined });
});
it("preserves knowledge receipts for dispatch and review while keeping candidate validation", () => {
  const knowledge = { query: "支付单类型", status: "已检索知识库", sources: ["projects/refund/concepts/pay-order-type-scheme-routing.md"] };
  const decision = { action: "dispatch" as const, projectId: "refund", agentType: "codex" as const, reason: "知识库匹配 Refund", knowledgeQuery: knowledge.query, knowledge };
  expect(validateRoutingDecision(decision, candidateFixture)).toMatchObject({ knowledgeQuery: knowledge.query, knowledge });
  expect(validateRoutingDecision({ ...decision, action: "review" }, candidateFixture)).toMatchObject({ action: "review", knowledge });
  expect(() => validateRoutingDecision({ ...decision, projectId: "unregistered" }, candidateFixture)).toThrow("候选列表");
});
