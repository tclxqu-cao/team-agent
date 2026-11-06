import { expect, it } from "vitest";
import { messageFixture } from "../testing/fixtures";
import { ModelMessageRecognizer } from "./model-recognizer";
import type { MessagingModelFactory } from "../model";

function setup(response: string) {
  const messages: unknown[] = [];
  const options: unknown[] = [];
  const model: MessagingModelFactory = () => ({ model: "fixture/recognizer", provider: { async *streamChat(input, config) {
    messages.push(input); options.push(config); yield { type: "text_chunk", text: response };
  } } });
  return { recognizer: new ModelMessageRecognizer(model), messages, options };
}
it("extracts business intent and search terms without choosing projects or running tools", async () => {
  const { recognizer, messages, options } = setup(JSON.stringify({ kind: "task", reason: "请求检查映射", knowledgeQuery: "支付单类型 映射", projectId: "/etc" }));
  const result = await recognizer.recognize(messageFixture({ text: "这个支付单类型是我们决定吗，你帮忙看看" }), []);
  expect(result).toEqual({ kind: "task", reason: "请求检查映射", knowledgeQuery: "支付单类型 映射", model: "fixture/recognizer" });
  expect(JSON.stringify(messages)).toContain("不可信数据");
  expect(options[0]).not.toHaveProperty("tools");
  expect(options[0]).not.toHaveProperty("maxTokens");
});
it("recognizes private follow-ups using both sides of the conversation", async () => {
  const { recognizer, messages } = setup(JSON.stringify({ kind: "reply", reason: "继续教学", knowledgeQuery: "AgentRoam" }));
  expect(await recognizer.recognize(messageFixture({ conversationType: "direct", text: "教教我" }), [{ role: "assistant", text: "后续就是 Agent 跟我打工了" }])).toMatchObject({ kind: "reply", knowledgeQuery: "AgentRoam" });
  expect(JSON.stringify(messages)).toContain("后续就是 Agent 跟我打工了");
});
it("rejects malformed recognition and disallows group conversational replies", async () => {
  await expect(setup("not JSON").recognizer.recognize(messageFixture(), [])).rejects.toThrow();
  await expect(setup(JSON.stringify({ kind: "invalid", reason: "bad" })).recognizer.recognize(messageFixture(), [])).rejects.toThrow("意图");
  await expect(setup(JSON.stringify({ kind: "reply", reason: "闲聊" })).recognizer.recognize(messageFixture(), [])).rejects.toThrow("私聊");
});
