import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MessageTable } from "./MessagingPage";
import MessageDetail from "./MessageDetail";
import MessageSettings from "./MessageSettings";
import { candidateFixture, messageFixture } from "../../../../messaging/src/testing/fixtures";
import type { MessageRecord, DeliveryRecord } from "@agent/messaging";

const record: MessageRecord = {
  id: "message-1", source: messageFixture({ text: "检查报错", raw: { displayText: "@我 <script>bad()</script>", RID: "1152921504606846983" } }),
  receivedAt: "2026-11-03T08:00:00Z", updatedAt: "2026-11-03T08:01:00Z", revision: 1,
  routing: { status: "routed", mode: "model", candidates: candidateFixture, decision: { action: "dispatch", projectId: "refund", agentType: "codex", reason: "消息明确提及赔付项目", model: "test/router" } },
  execution: { status: "completed", sessionId: "runtime:codex:source", projectName: "Refund", runId: "run-1", lastSequence: 5, result: "根因已确认" },
  timeline: [{ at: "2026-11-03T08:00:00Z", stage: "routed", text: "模型已选择 Refund" }],
};
const delivery: DeliveryRecord = {
  id: "delivery", messageId: record.id, eventId: "run:5", event: "completed", target: { kind: "origin", address: "group", label: "赔付研发群" },
  text: "根因已确认", status: "blocked", attempts: 1, nextAttemptAt: 0, createdAt: record.receivedAt, updatedAt: record.updatedAt, error: "发送通道未登录",
};
it("offers explicit retry for a failed session creation and blocks retry after any execution receipt", () => {
  const render = (message: MessageRecord) => renderToStaticMarkup(createElement(MessageDetail, {
    message, deliveries: [], candidates: candidateFixture, onBack() {}, onResolve() {}, onRetry() {},
  }));
  const failed: MessageRecord = { ...record, execution: { status: "failed", lastSequence: 0, error: "project not found: local-project" } };
  expect(render(failed)).toContain("重新派发");
  expect(render(failed)).toContain("尚未派发");
  expect(render({ ...failed, execution: { ...failed.execution, runId: "accepted-run" } })).not.toContain("重新派发");
});
it("shows technical routing errors in the console without presenting them as outbound messages", () => {
  const message: MessageRecord = { ...record, routing: { status: "review", mode: "model", error: "输出被截断", decision: { action: "review", reason: "输出被截断" } },
    execution: { status: "pending", lastSequence: 0 } };
  const html = renderToStaticMarkup(createElement(MessageDetail, { message, deliveries: [], candidates: candidateFixture, onBack() {}, onResolve() {}, onRetry() {} }));
  expect(html).toContain('role="alert"');
  expect(html).toContain("消息判断失败");
  expect(html).toContain("未自动回传原聊天");
});
it("shows model evidence, source bytes, exact session and independent execution/delivery outcomes", () => {
  const html = renderToStaticMarkup(createElement(MessageDetail, { message: record, deliveries: [delivery], candidates: candidateFixture, onBack() {}, onResolve() {}, onRetry() {} }));
  for (const text of ["模型判断", "test/router", "消息明确提及赔付项目", "runtime:codex:source", "已完成", "通道未就绪", "发送通道未登录", "监听原始数据", "1152921504606846983", "根因已确认", "重试回传"]) expect(html).toContain(text);
  expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>bad()");
  expect(html).toContain("/app/?agent=codex&amp;session=runtime%3Acodex%3Asource");
});
it("keeps the list outcome columns separate and the default model settings free of group fields", () => {
  const html = renderToStaticMarkup(createElement(MessageTable, { messages: [{ ...record, deliveryStatus: "failed" }], selected: null, onSelect() {} }));
  expect(html).toContain("已完成"); expect(html).toContain("回传失败"); expect(html).toContain("结果回传");
  const settings = renderToStaticMarkup(createElement(MessageSettings, {
    value: { enabled: false, routingMode: "model", source: { accountId: "", database: "" }, rules: [], subscriptions: [] },
    candidates: candidateFixture, sources: [], busy: false, onChange() {}, onDiscover() {}, onSave() {}, onClose() {},
  }));
  expect(settings).toContain("模型判断（默认）"); expect(settings).not.toContain("群会话 ID"); expect(settings).toContain("默认回到原渠道原会话");
  expect(settings).toContain('<dialog');
});
it("shows project-routing knowledge separately from reply evidence and retains it after confirmation", () => {
  const decision = { ...record.routing.decision!, knowledge: { query: "支付单类型 映射", status: "已检索知识库，引用 1 篇资料",
    sources: ["projects/refund/concepts/pay-order-type-scheme-routing.md"] } };
  const render = (message: MessageRecord) => renderToStaticMarkup(createElement(MessageDetail, {
    message, deliveries: [], candidates: candidateFixture, onBack() {}, onResolve() {}, onRetry() {},
  }));
  for (const routing of [
    { ...record.routing, decision },
    { ...record.routing, confirmedByUser: true, initialDecision: decision },
  ]) {
    const html = render({ ...record, routing });
    for (const text of ["判断时参考的知识库", "支付单类型 映射", "引用 1 篇资料", "projects/refund/concepts/pay-order-type-scheme-routing.md"]) expect(html).toContain(text);
    expect(html).not.toContain("回复参考的知识库");
  }
});
it("shows private conversation replies and their knowledge evidence independently from delivery", () => {
  const message: MessageRecord = { ...record, source: { ...record.source, conversationType: "direct", directMention: false },
    routing: { status: "routed", mode: "model", decision: { action: "reply", reason: "私聊教学" } },
    execution: { status: "completed", lastSequence: 0, result: "先从会话管理开始", reply: { model: "test/reply", knowledge: { query: "AgentRoam", status: "已检索知识库", sources: ["concepts/agentroam.md"] } } } };
  const html = renderToStaticMarkup(createElement(MessageDetail, { message, deliveries: [{ ...delivery, purpose: "reply" }], candidates: [], onBack() {}, onResolve() {}, onRetry() {} }));
  expect(html).toContain("私聊回复"); expect(html).toContain("回复参考的知识库"); expect(html).toContain("concepts/agentroam.md");
  expect(html).not.toContain("未直接 @我"); expect(html).not.toContain("尚未确定");
  const list = renderToStaticMarkup(createElement(MessageTable, { messages: [{ ...message, deliveryStatus: "blocked" }], selected: null, onSelect() {} }));
  expect(list).toContain("私聊回复"); expect(list).toContain("通道未就绪");
});
