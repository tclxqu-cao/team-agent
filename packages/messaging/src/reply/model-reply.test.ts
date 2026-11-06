import { expect, it, vi } from "vitest";
import type { MessageRecord } from "../domain/types";
import { messageFixture } from "../testing/fixtures";
const fixture = vi.hoisted(() => ({ response: "可以先从 AgentRoam 的会话管理开始。", messages: null as unknown, options: null as unknown, error: "" }));
const model = () => ({ model: "fixture/reply", provider: { async *streamChat(messages: unknown, options: unknown) {
  fixture.messages = messages; fixture.options = options;
  if (fixture.error) yield { type: "error" as const, message: fixture.error };
  else yield { type: "text_chunk" as const, text: fixture.response };
} } });
import { ConversationalReply } from "./model-reply";

const record: MessageRecord = {
  id: "private", source: messageFixture({ conversationType: "direct", directMention: false, text: "教教我" }),
  receivedAt: "", updatedAt: "", revision: 0, timeline: [], execution: { status: "pending", lastSequence: 0 },
  routing: { status: "routed", mode: "model", decision: { action: "reply", reason: "继续 Agent 话题", knowledgeQuery: "AgentRoam" },
    context: [{ role: "assistant", text: "后续就是 Agent 跟我打工了" }] },
};
it("grounds a tool-free conversational reply in the recent dialogue and real wiki excerpts", async () => {
  const search = vi.fn().mockResolvedValue({ query: "AgentRoam", status: "已检索知识库", snippets: [{ path: "concepts/agentroam.md", title: "AgentRoam", text: "统一管理多种 Agent 会话" }] });
  const reply = await new ConversationalReply(model, { search }).reply(record);
  expect(search).toHaveBeenCalledWith("AgentRoam");
  expect(reply).toEqual({ text: fixture.response, model: "fixture/reply", knowledge: { query: "AgentRoam", status: "已检索知识库", sources: ["concepts/agentroam.md"] } });
  expect(JSON.stringify(fixture.messages)).toContain("后续就是 Agent 跟我打工了");
  expect(JSON.stringify(fixture.messages)).toContain("统一管理多种 Agent 会话");
  expect(JSON.stringify(fixture.messages)).toContain("不可信参考数据");
  expect(fixture.options).not.toHaveProperty("tools");
  expect(fixture.options).not.toHaveProperty("maxTokens");
});
it("preserves a missing-knowledge status and rejects failed or empty model responses", async () => {
  const search = vi.fn().mockResolvedValue({ query: "AgentRoam", status: "知识库未检索到相关资料", snippets: [] });
  expect((await new ConversationalReply(model, { search }).reply(record)).knowledge).toMatchObject({ status: "知识库未检索到相关资料", sources: [] });
  fixture.error = "model failed";
  await expect(new ConversationalReply(model, { search }).reply(record)).rejects.toThrow("model failed");
  fixture.error = ""; fixture.response = " ";
  await expect(new ConversationalReply(model, { search }).reply(record)).rejects.toThrow("未生成");
});
