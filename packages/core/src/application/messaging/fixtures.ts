import type { ChannelMessage, RoutingCandidate } from "../../domain/messaging/types.js";
export const messageFixture = (overrides: Partial<ChannelMessage> = {}): ChannelMessage => ({
  sourceId: "message-1", connectionId: "wecom:123", channel: "wecom", conversationId: "group-1",
  conversationName: "赔付研发群", senderId: "sender", text: "请检查 refund 项目的报错",
  occurredAt: "2026-11-03T08:00:00Z", directMention: true, ownMessage: false,
  raw: { contentBase64: "Zm9v", displayText: "@我 请检查 refund 项目的报错" }, ...overrides,
});
export const candidateFixture: RoutingCandidate[] = [{ projectId: "refund", projectName: "Refund", description: "/projects/refund", agents: ["codex"] }];
