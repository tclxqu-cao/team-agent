import { expect, it, vi } from "vitest";
import { candidateFixture, messageFixture } from "../testing/fixtures";
import { KnowledgeMessageRouter } from "./model-router";
import type { MessagingModelFactory } from "../model";

function setup(response: string) {
  const messages: unknown[] = [];
  const options: unknown[] = [];
  const model: MessagingModelFactory = () => ({ model: "fixture/router", provider: { async *streamChat(input, config) {
    messages.push(input); options.push(config); yield { type: "text_chunk", text: response };
  } } });
  const search = vi.fn(async (query: string) => ({ query, status: "知识库未检索到相关资料", snippets: [] as Array<{ path: string; title: string; text: string }> }));
  return { router: new KnowledgeMessageRouter(model, { search }), messages, options, search };
}
const recognition = { kind: "task" as const, reason: "请求诊断", knowledgeQuery: "支付单类型 映射", model: "fixture/recognizer" };

it("uses wiki evidence and registered candidates to select a project after intent recognition", async () => {
  const path = "projects/refund/concepts/pay-order-type-scheme-routing.md";
  const { router, search, messages, options } = setup(JSON.stringify({ action: "dispatch", projectId: "refund", agentType: "codex", reason: "支付单类型属于赔付方案映射", knowledge: { sources: ["invented.md"] } }));
  search.mockResolvedValue({ query: recognition.knowledgeQuery, status: "已检索知识库", snippets: [{ path, title: "支付单类型的方案路由", text: "Refund 支付单类型取自赔付原因及方案配置。" }] });
  const result = await router.route(messageFixture({ conversationName: "unknown", text: "这个支付单类型是我们决定吗，你帮忙看看" }),
    [...candidateFixture, { projectId: "csc", projectName: "CSC", description: "/projects/csc-main", agents: ["codex"] }],
    [{ role: "user", text: "看下哈，还是映射问题" }], recognition);
  expect(search).toHaveBeenCalledWith(recognition.knowledgeQuery);
  expect(result).toMatchObject({ action: "dispatch", projectId: "refund", knowledge: { sources: [path] } });
  expect(JSON.stringify(messages)).toContain("Refund 支付单类型取自赔付原因及方案配置");
  expect(JSON.stringify(messages)).toContain("不可信数据");
  expect(JSON.stringify(result)).not.toContain("invented.md");
  expect(options[0]).not.toHaveProperty("tools");
  expect(options[0]).not.toHaveProperty("maxTokens");
});
it("still routes an explicit project when no knowledge matches and preserves the retrieval status", async () => {
  const { router, search } = setup(JSON.stringify({ action: "dispatch", projectId: "refund", agentType: "codex", reason: "正文明确提到 refund" }));
  expect(await router.route(messageFixture(), candidateFixture, [], recognition)).toMatchObject({ action: "dispatch", knowledge: { sources: [] } });
  search.mockRejectedValueOnce(new Error("wiki unavailable"));
  expect(await router.route(messageFixture(), candidateFixture, [], recognition)).toMatchObject({ action: "dispatch", knowledge: { status: "知识库检索失败，已按消息和近期对话判断" } });
});
it("surfaces malformed model output as a technical error and keeps genuine ambiguous decisions in review", async () => {
  const { router } = setup("not JSON");
  await expect(router.route(messageFixture(), candidateFixture, [], recognition)).rejects.toMatchObject({ name: "MessagingModelError" });
  const ambiguous = setup(JSON.stringify({ action: "review", reason: "多个项目可能相关" }));
  expect(await ambiguous.router.route(messageFixture(), candidateFixture, [], recognition)).toMatchObject({ action: "review", reason: "多个项目可能相关" });
});
it("can prepare direct replies without execution candidates and ignores notifications without retrieval", async () => {
  const { router, messages, search } = setup("unused");
  expect(await router.route(messageFixture({ conversationType: "direct" }), [], [], { ...recognition, kind: "reply" })).toMatchObject({ action: "reply", knowledgeQuery: recognition.knowledgeQuery });
  expect(messages).toHaveLength(0);
  search.mockClear();
  expect(await router.route(messageFixture(), [], [], { kind: "ignore", reason: "自动通知" })).toMatchObject({ action: "ignore" });
  expect(search).not.toHaveBeenCalled();
  await expect(router.route(messageFixture(), [], [], { ...recognition, kind: "reply" })).rejects.toThrow("私聊");
});
it("returns review without invoking a routing model when no executable candidates exist", async () => {
  const { router, messages } = setup("unused");
  expect(await router.route(messageFixture(), [], [], recognition)).toMatchObject({ action: "review" });
  expect(messages).toHaveLength(0);
});
it("rejects project or Agent choices outside the supplied candidates at the public routing boundary", async () => {
  for (const target of [{ projectId: "/etc", agentType: "codex" }, { projectId: "refund", agentType: "workbuddy" }]) {
    const { router } = setup(JSON.stringify({ action: "dispatch", reason: "untrusted suggestion", ...target }));
    expect(await router.route(messageFixture(), candidateFixture, [], recognition)).toMatchObject({ action: "review", knowledge: { sources: [] } });
  }
});
