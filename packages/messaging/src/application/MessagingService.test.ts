import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteMessagingRepository } from "../infrastructure/SQLiteMessagingRepository.js";
import { getDatabase } from "@agent/core";
import { DEFAULT_MESSAGING_SETTINGS } from "../domain/types.js";
import type { MessageRouter, MessageRecognizer, MessageReplies, MessageSender, MessagingExecution, ExecutionObservation } from "./ports.js";
import { MessagingService } from "./MessagingService.js";
import { candidateFixture, messageFixture } from "../testing/fixtures.js";

const paths: string[] = [];
afterEach(() => { paths.splice(0).forEach(path => { getDatabase(path).close(); rmSync(path, { recursive: true, force: true }); }); });
function setup() {
  const path = mkdtempSync(join(tmpdir(), "messaging-service-")); paths.push(path);
  const repository = new SQLiteMessagingRepository(path);
  repository.saveSettings({ ...structuredClone(DEFAULT_MESSAGING_SETTINGS), enabled: true });
  const runtime = {
    recognize: vi.fn<MessageRecognizer["recognize"]>(async () => ({ kind: "task", reason: "请求诊断项目" })),
    candidates: vi.fn(async () => candidateFixture),
    route: vi.fn<MessageRouter["route"]>(async () => ({ action: "dispatch", projectId: "refund", agentType: "codex", reason: "消息明确提到 refund", model: "fixture/router" })),
    reply: vi.fn<MessageReplies["reply"]>(async () => ({ text: "可以先从 AgentRoam 的会话管理开始，选一个熟悉的项目试试。", model: "fixture/reply", knowledge: { query: "AgentRoam", status: "已检索知识库", sources: ["projects/customer-agent/concepts/sessions.md"] } })),
    createSession: vi.fn(async () => "runtime:codex:source"),
    dispatch: vi.fn(async () => ({ queueItemId: "item-1", runId: "run-1" })),
    observe: vi.fn(async (): Promise<ExecutionObservation> => ({ status: "running", events: [] })),
    send: vi.fn<MessageSender["send"]>(async () => ({ status: "sent", receipt: "fixture-receipt" })),
  } satisfies MessagingExecution & MessageRouter & MessageReplies & MessageSender & MessageRecognizer;
  return { path, repository, runtime, service: new MessagingService(repository, { recognizer: runtime, router: runtime, execution: runtime, replies: runtime, sender: runtime }) };
}
it("deduplicates receipt, persists routing evidence, and separates completed execution from uncertain delivery", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture());
  expect(service.receive(messageFixture()).id).toBe(record.id);
  await service.routePending(); await service.executePending();
  runtime.observe.mockResolvedValue({ status: "completed", sequence: 3, runId: "run-1", events: [{ id: "run-1:3", sequence: 3, kind: "completed", text: "已确认根因" }] });
  await service.executePending();
  expect(repository.get(record.id)?.execution.result).toBe("已确认根因");
  expect(repository.get(record.id)?.routing.decision?.model).toBe("fixture/router");
  runtime.send.mockRejectedValueOnce(new Error("ack lost"));
  await service.deliver(); await service.deliver();
  expect(repository.get(record.id)?.execution.status).toBe("completed");
  expect(repository.deliveries(record.id)[0].status).toBe("unknown");
  expect(runtime.send).toHaveBeenCalledTimes(1);
  expect(runtime.dispatch).toHaveBeenCalledTimes(1);
  service.receive(messageFixture()); await service.routePending(); await service.executePending();
  expect(runtime.route).toHaveBeenCalledTimes(1);
});
it("keeps untrusted model targets in review and allows a validated manual decision", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture());
  runtime.route.mockResolvedValueOnce({ action: "dispatch", projectId: "not-registered", agentType: "codex", reason: "injected", model: "fixture" });
  await service.routePending(); await service.executePending();
  expect(repository.get(record.id)?.routing.status).toBe("review");
  expect(runtime.dispatch).not.toHaveBeenCalled();
  await expect(service.resolve(record.id, { action: "dispatch", projectId: "outside", agentType: "codex", reason: "manual" })).rejects.toThrow("候选列表");
  await service.resolve(record.id, { action: "dispatch", projectId: "refund", agentType: "codex", reason: "manual" });
  expect(repository.get(record.id)?.routing.confirmedByUser).toBe(true);
  expect(repository.get(record.id)?.routing.initialDecision?.reason).toContain("候选列表");
  await service.executePending(); expect(runtime.dispatch).toHaveBeenCalledTimes(1);
});
it("persists project-routing knowledge and retains the original evidence after manual confirmation", async () => {
  const { path, repository, service, runtime } = setup();
  const knowledge = { query: "支付单类型", status: "已检索知识库", sources: ["projects/refund/concepts/pay-order-type-scheme-routing.md"] };
  runtime.route.mockResolvedValueOnce({ action: "review", reason: "知识库存在多个项目关联", knowledgeQuery: knowledge.query, knowledge });
  const record = service.receive(messageFixture());
  await service.routePending();
  expect(new SQLiteMessagingRepository(path).get(record.id)?.routing.decision?.knowledge).toEqual(knowledge);
  await service.resolve(record.id, { action: "dispatch", projectId: "refund", agentType: "codex", reason: "确认属于赔付项目" });
  expect(repository.get(record.id)?.routing.initialDecision?.knowledge).toEqual(knowledge);
  expect(runtime.dispatch).not.toHaveBeenCalled();
});
it("uses simple rules without calling the model and excludes own/non-mention messages", async () => {
  const { repository, service, runtime } = setup();
  repository.saveSettings({ ...repository.settings(), routingMode: "rules", rules: [{ conversationId: "group-1", projectId: "refund", agentType: "codex" }] });
  service.receive(messageFixture({ sourceId: "own", ownMessage: true }));
  service.receive(messageFixture({ sourceId: "plain", directMention: false }));
  const record = service.receive(messageFixture());
  await service.routePending();
  expect(runtime.route).not.toHaveBeenCalled();
  expect(repository.get(record.id)?.routing.status).toBe("routed");
  expect(repository.list().counts.total).toBe(3);
});
it("reconciles a persisted dispatch intent after restart without dispatching again", async () => {
  const { repository, service, runtime, path } = setup();
  const record = service.receive(messageFixture()); await service.routePending();
  const intent = repository.get(record.id)!;
  intent.execution = { ...intent.execution, status: "dispatching", sessionId: "runtime:codex:source" };
  repository.save(intent);
  runtime.observe.mockResolvedValue({ status: "completed", queueItemId: "item-1", runId: "run-1", sequence: 1, events: [{ id: "run-1:1", sequence: 1, kind: "completed", text: "已完成" }] });
  const restarted = new MessagingService(new SQLiteMessagingRepository(path), { recognizer: runtime, router: runtime, execution: runtime, replies: runtime, sender: runtime });
  await restarted.executePending();
  expect(runtime.dispatch).not.toHaveBeenCalled();
  expect(repository.get(record.id)?.execution.status).toBe("completed");
  expect(repository.deliveries(record.id)).toHaveLength(1);
});
it("continues observing an in-flight session while collection is paused", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture()); await service.routePending(); await service.executePending();
  repository.saveSettings({ ...repository.settings(), enabled: false });
  runtime.observe.mockResolvedValue({ status: "completed", sequence: 2, events: [{ id: "run:2", sequence: 2, kind: "completed", text: "ok" }] });
  await service.executePending(); await service.deliver();
  expect(repository.get(record.id)?.execution.status).toBe("completed");
  expect(repository.deliveries(record.id)[0].status).toBe("sent");
});
it("retries a blocked delivery independently without rerunning the Agent", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture()); await service.routePending();
  runtime.observe.mockResolvedValue({ status: "completed", sequence: 1, events: [{ id: "run:1", sequence: 1, kind: "completed", text: "done" }] });
  await service.executePending();
  runtime.send.mockResolvedValueOnce({ status: "blocked", receipt: "not-sent" });
  await service.deliver();
  const delivery = repository.deliveries(record.id)[0]; service.retryDelivery(delivery.id); await service.deliver();
  expect(repository.deliveries(record.id)[0]).toMatchObject({ status: "sent", attempts: 2 });
  expect(runtime.dispatch).toHaveBeenCalledTimes(1);
});
it("returns an inspectable failure when the target cannot be prepared before dispatch", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture()); await service.routePending();
  runtime.createSession.mockRejectedValueOnce(new Error("readonly policy unavailable"));
  await service.executePending();
  expect(repository.get(record.id)?.execution.status).toBe("failed");
  expect(repository.deliveries(record.id)).toEqual([]);
  expect(runtime.dispatch).not.toHaveBeenCalled();
});
it("allows a failed session creation to be retried only after the user confirms its target again", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture());
  await service.routePending();
  runtime.createSession.mockRejectedValueOnce(new Error("project not found: local-project"));
  await service.executePending(); await service.executePending();
  expect(runtime.createSession).toHaveBeenCalledTimes(1);
  await service.resolve(record.id, { action: "dispatch", projectId: "refund", agentType: "codex", reason: "确认目标后重试" });
  expect(repository.get(record.id)?.execution).toMatchObject({ status: "pending" });
  expect(repository.get(record.id)?.execution.error).toBeUndefined();
  await service.executePending();
  expect(runtime.dispatch).toHaveBeenCalledTimes(1);
  expect(repository.get(record.id)?.execution.status).toBe("running");
  await expect(service.resolve(record.id, { action: "dispatch", projectId: "refund", agentType: "codex", reason: "again" })).rejects.toThrow("未派发");
});
it.each(["输出被截断（max_tokens 限制）", "OpenAI API error 429", "model request timeout"])(
  "keeps recognition failure %s in the console without sending it to the contact or subscriptions", async error => {
    const { repository, service, runtime } = setup();
    repository.saveSettings({ ...repository.settings(), subscriptions: [
      { id: "extra", enabled: true, events: ["waiting"], kind: "webhook", address: "https://example.test", label: "extra" },
    ] });
    runtime.recognize.mockRejectedValueOnce(new Error(error));
    const record = service.receive(messageFixture({ conversationType: "direct", text: "你是第一个吗" }));
    await service.routePending(); await service.executePending(); await service.deliver();
    expect(repository.get(record.id)?.routing).toMatchObject({ status: "review", error, decision: { action: "review", reason: error } });
    expect(repository.deliveries(record.id)).toEqual([]);
    expect(runtime.reply).not.toHaveBeenCalled(); expect(runtime.dispatch).not.toHaveBeenCalled(); expect(runtime.send).not.toHaveBeenCalled();
  },
);
it("keeps genuine business confirmations deliverable while retaining model failures for manual routing", async () => {
  const { repository, service, runtime } = setup();
  runtime.route.mockResolvedValueOnce({ action: "review", reason: "两个项目都可能相关，请选择" });
  const business = service.receive(messageFixture({ sourceId: "business" }));
  await service.routePending();
  expect(repository.deliveries(business.id)[0].text).toBe("需要你的确认\n两个项目都可能相关，请选择");
  runtime.recognize.mockRejectedValueOnce(new Error("model unavailable"));
  const technical = service.receive(messageFixture({ sourceId: "technical" }));
  await service.routePending();
  await service.resolve(technical.id, { action: "dispatch", projectId: "refund", agentType: "codex", reason: "用户手动选择执行目标" });
  expect(repository.get(technical.id)?.routing.error).toBeUndefined();
  expect(repository.get(technical.id)?.routing.initialDecision?.reason).toBe("model unavailable");
});
it("keeps a mention without decoded task text in review without calling the model", async () => {
  const { repository, service, runtime } = setup();
  const record = service.receive(messageFixture({ text: "" }));
  await service.routePending();
  expect(repository.get(record.id)?.routing.status).toBe("review");
  expect(runtime.route).not.toHaveBeenCalled();
  expect(repository.deliveries(record.id)[0].event).toBe("waiting");
});
it("admits incoming private messages without mentions while keeping own messages and ordinary groups excluded", async () => {
  const { repository, service, runtime } = setup();
  repository.saveSettings({ ...repository.settings(), routingMode: "rules" });
  const own = service.receive(messageFixture({ sourceId: "own", conversationType: "direct", directMention: false, ownMessage: true }));
  const group = service.receive(messageFixture({ sourceId: "group", directMention: false }));
  const direct = service.receive(messageFixture({ sourceId: "private", conversationType: "direct", directMention: false }));
  expect(own.routing.status).toBe("ignored"); expect(group.routing.status).toBe("ignored");
  expect(direct.routing).toMatchObject({ status: "pending", mode: "model" });
  await service.routePending();
  expect(runtime.route).toHaveBeenCalledTimes(1);
  expect(repository.list({ filter: "addressed" }).messages.map(item => item.id)).toEqual([direct.id]);
});
it("persists one knowledge-grounded private reply without dispatching an Agent or publishing subscriptions", async () => {
  const { repository, service, runtime } = setup();
  repository.saveSettings({ ...repository.settings(), subscriptions: [{ id: "extra", enabled: true, events: ["completed"], kind: "webhook", address: "https://example.test", label: "extra" }] });
  const source = messageFixture({ sourceId: "private", conversationType: "direct", directMention: false, text: "教教我" });
  runtime.route.mockResolvedValue({ action: "reply", reason: "继续讲解 AgentRoam", knowledgeQuery: "AgentRoam", model: "fixture/router" });
  const record = service.receive(source);
  await service.routePending(); await service.executePending();
  expect(repository.get(record.id)?.execution).toMatchObject({ status: "completed", reply: { model: "fixture/reply", knowledge: { sources: ["projects/customer-agent/concepts/sessions.md"] } } });
  expect(repository.deliveries(record.id)).toHaveLength(1);
  expect(repository.deliveries(record.id)[0]).toMatchObject({ purpose: "reply", target: { kind: "origin" }, text: "可以先从 AgentRoam 的会话管理开始，选一个熟悉的项目试试。" });
  expect(runtime.createSession).not.toHaveBeenCalled(); expect(runtime.dispatch).not.toHaveBeenCalled();
  service.receive(source); await service.routePending(); await service.executePending(); await service.deliver(); await service.deliver();
  expect(runtime.reply).toHaveBeenCalledTimes(1); expect(runtime.send).toHaveBeenCalledTimes(1);
});
it("uses both sides of the same conversation and includes only confirmed sent replies in later context", async () => {
  const { repository, service, runtime } = setup();
  const base = { conversationType: "direct" as const, directMention: false };
  service.receive(messageFixture({ ...base, sourceId: "mine", ownMessage: true, text: "后续就是 Agent 跟我打工了" }));
  service.receive(messageFixture({ ...base, sourceId: "elsewhere", conversationId: "another", text: "另一个人的私密话题", ownMessage: true }));
  runtime.route.mockResolvedValue({ action: "reply", reason: "闲聊", knowledgeQuery: "AgentRoam" });
  const first = service.receive(messageFixture({ ...base, sourceId: "first", text: "教教我" }));
  await service.routePending(); await service.executePending();
  const next = service.receive(messageFixture({ ...base, sourceId: "next", text: "怎么开始" }));
  expect(repository.context(next.source)).toEqual([
    { role: "assistant", text: "后续就是 Agent 跟我打工了" }, { role: "user", text: "教教我" },
  ]);
  await service.deliver();
  const context = repository.context(next.source);
  expect(context.at(-1)).toMatchObject({ role: "assistant", text: repository.get(first.id)?.execution.result });
  expect(JSON.stringify(context)).not.toContain("另一个人的私密话题");
});
it("keeps invalid group replies in review and does not send technical reply-generation errors to a contact", async () => {
  const { repository, service, runtime } = setup();
  runtime.route.mockResolvedValue({ action: "reply", reason: "闲聊" });
  const group = service.receive(messageFixture()); await service.routePending();
  expect(repository.get(group.id)?.routing.status).toBe("review"); expect(runtime.reply).not.toHaveBeenCalled();
  const direct = service.receive(messageFixture({ sourceId: "private", conversationType: "direct", directMention: false }));
  await service.routePending(); runtime.reply.mockRejectedValueOnce(new Error("model unavailable")); await service.executePending();
  expect(repository.get(direct.id)?.execution.status).toBe("failed");
  expect(repository.deliveries(direct.id)).toEqual([]);
});
it("persists recognized intent and handles direct replies without discovering execution projects", async () => {
  const { repository, service, runtime } = setup();
  runtime.recognize.mockResolvedValue({ kind: "reply", reason: "接续 AgentRoam 话题", knowledgeQuery: "AgentRoam", model: "fixture/recognizer" });
  runtime.route.mockResolvedValue({ action: "reply", reason: "私聊教学", knowledgeQuery: "AgentRoam" });
  const record = service.receive(messageFixture({ conversationType: "direct", directMention: false, text: "教教我" }));
  await service.routePending();
  expect(runtime.candidates).not.toHaveBeenCalled();
  expect(repository.get(record.id)?.routing.recognition).toMatchObject({ kind: "reply", knowledgeQuery: "AgentRoam" });
  expect(repository.get(record.id)?.timeline.some(event => event.stage === "recognized")).toBe(true);
});
