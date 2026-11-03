import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MessageTable } from "./MessagingPage";
import MessageDetail from "./MessageDetail";
import MessageSettings from "./MessageSettings";
import { candidateFixture, messageFixture } from "../../../../core/src/application/messaging/fixtures";
import type { MessageRecord, DeliveryRecord } from "../../../../core/src/domain/messaging/types";

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
    candidates: candidateFixture, sources: [], busy: false, error: "发现账号失败", onChange() {}, onDiscover() {}, onSave() {}, onClose() {},
  }));
  expect(settings).toContain("模型判断（默认）"); expect(settings).not.toContain("群会话 ID"); expect(settings).toContain("默认回到原渠道原会话");
  expect(settings).toContain('<dialog');
  expect(settings).toContain('role="alert">发现账号失败');
});
