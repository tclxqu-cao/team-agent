import { afterEach, expect, it, vi } from "vitest";
import { ChannelDelivery, decodeWecomResponse, messageText } from "./ChannelDelivery";
import { messageFixture } from "../testing/fixtures";
import type { DeliveryRecord } from "../domain/types";

afterEach(() => vi.unstubAllGlobals());
it("keeps a multi-byte reply within the official WeCom message limit", () => {
  const text = messageText("中文🙂".repeat(1000), "\nhttps://agent.example/app/");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2048);
  expect(text).toContain("完整结果");
  expect(text).not.toContain("�");
});
it("uses a stable delivery key and never turns an interrupted send into success", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("connection reset")); vi.stubGlobal("fetch", fetch);
  const delivery: DeliveryRecord = { id: "delivery-1", messageId: "message-1", eventId: "run:1", event: "completed", text: "done", target: { kind: "webhook", address: "https://notify.example/events", label: "test" }, status: "pending", attempts: 1, nextAttemptAt: 0, createdAt: "", updatedAt: "" };
  expect((await new ChannelDelivery().send(delivery, messageFixture())).status).toBe("unknown");
  expect(fetch.mock.calls[0][1].headers["idempotency-key"]).toBe("delivery-1");
});
it("verifies origin content/time before converting a local conversation ID to an official chat ID", async () => {
  const source = messageFixture({ occurredAt: new Date().toISOString() });
  const sendTime = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(source.occurredAt));
  const execute = vi.fn()
    .mockResolvedValueOnce({ errcode: 0, chats: [{ chat_id: "wr-official", chat_name: source.conversationName }] })
    .mockResolvedValueOnce({ errcode: 0, messages: [{ msgtype: "text", send_time: sendTime, text: { content: source.text } }] })
    .mockResolvedValueOnce({ errcode: 0, errmsg: "ok" });
  const delivery: DeliveryRecord = { id: "one", messageId: "message", eventId: "run:1", event: "completed", target: { kind: "origin", address: "local-numeric", label: "原会话" }, text: "done", status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: "", updatedAt: "" };
  expect((await new ChannelDelivery(execute).send(delivery, source)).status).toBe("sent");
  expect(execute).toHaveBeenLastCalledWith("send_message", expect.objectContaining({ chatid: "wr-official" }));
});
it("does not send merely because the official account has a uniquely named group", async () => {
  const source = messageFixture({ occurredAt: new Date().toISOString() });
  const execute = vi.fn().mockResolvedValueOnce({ errcode: 0, chats: [{ chat_id: "wr-other", chat_name: source.conversationName }] })
    .mockResolvedValueOnce({ errcode: 0, messages: [] });
  const delivery: DeliveryRecord = { id: "two", messageId: "message", eventId: "run:2", event: "completed", target: { kind: "origin", address: "local-id", label: "原会话" }, text: "done", status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: "", updatedAt: "" };
  expect((await new ChannelDelivery(execute).send(delivery, source)).status).toBe("blocked");
  expect(execute).toHaveBeenCalledTimes(2);
});
it("decodes the actual CLI JSON-RPC envelope and preserves an expired authorization error", async () => {
  const response = decodeWecomResponse(JSON.stringify({ jsonrpc: "2.0", result: { content: [{ type: "text", text: JSON.stringify({ errcode: 850003, errmsg: "authorization expired", help_message: "请重新授权" }) }] } }));
  const execute = vi.fn().mockResolvedValue(response);
  const source = messageFixture({ conversationType: "direct", peerUserId: "zhengyin.cai", occurredAt: new Date().toISOString() });
  const delivery: DeliveryRecord = { id: "expired", messageId: "message", eventId: "reply:message", event: "completed", purpose: "reply", text: "你好", target: { kind: "origin", address: source.conversationId, label: source.conversationName }, status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: "", updatedAt: "" };
  expect(await new ChannelDelivery(execute).send(delivery, source)).toMatchObject({ status: "blocked", error: expect.stringContaining("请重新授权") });
  expect(execute).toHaveBeenCalledTimes(1); expect(execute.mock.calls[0][0]).toBe("get_message");
});
it("verifies the private sender and sends a plain chat reply with chat_type one", async () => {
  vi.stubEnv("AGENT_PUBLIC_URL", "https://agent.example");
  const source = messageFixture({ conversationType: "direct", peerUserId: "zhengyin.cai", occurredAt: new Date().toISOString(), text: "教教我" });
  const sendTime = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(source.occurredAt));
  const execute = vi.fn().mockResolvedValueOnce({ errcode: 0, messages: [{ userid: "zhengyin.cai", msgtype: "text", send_time: sendTime, text: { content: source.text } }] })
    .mockResolvedValueOnce({ errcode: 0, errmsg: "ok" });
  const delivery: DeliveryRecord = { id: "private", messageId: "message", eventId: "reply:message", event: "completed", purpose: "reply", text: "可以先从会话管理开始。", target: { kind: "origin", address: source.conversationId, label: source.conversationName }, status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: "", updatedAt: "" };
  expect(await new ChannelDelivery(execute).send(delivery, source)).toMatchObject({ status: "sent" });
  expect(execute).toHaveBeenNthCalledWith(1, "get_message", expect.objectContaining({ chat_type: 1, chatid: "zhengyin.cai" }));
  expect(execute).toHaveBeenLastCalledWith("send_message", { chat_type: 1, chatid: "zhengyin.cai", msgtype: "text", text: { content: "可以先从会话管理开始。" } });
  vi.unstubAllEnvs();
});
it("blocks a private reply when the matching original belongs to another sender", async () => {
  const source = messageFixture({ conversationType: "direct", peerUserId: "zhengyin.cai", occurredAt: new Date().toISOString() });
  const sendTime = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(source.occurredAt));
  const execute = vi.fn().mockResolvedValue({ errcode: 0, messages: [{ userid: "someone.else", msgtype: "text", send_time: sendTime, text: { content: source.text } }] });
  const delivery: DeliveryRecord = { id: "wrong", messageId: "message", eventId: "reply:message", event: "completed", text: "hello", target: { kind: "origin", address: source.conversationId, label: source.conversationName }, status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: "", updatedAt: "" };
  expect((await new ChannelDelivery(execute).send(delivery, source)).status).toBe("blocked");
  expect(execute).toHaveBeenCalledTimes(1);
});
it("uses the configured local sender without invoking the official CLI", async () => {
  const execute = vi.fn();
  const native = vi.fn().mockResolvedValue({ status: "sent", receipt: "native receipt" });
  const source = messageFixture();
  const delivery: DeliveryRecord = { id: "local", messageId: "message", eventId: "reply:message", event: "completed", purpose: "reply", text: "你好",
    target: { kind: "origin", address: source.conversationId, label: source.conversationName }, status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: "", updatedAt: "" };
  expect(await new ChannelDelivery(execute, native).send(delivery, source)).toEqual({ status: "sent", receipt: "native receipt" });
  expect(native).toHaveBeenCalledWith(delivery, source, "你好");
  expect(execute).not.toHaveBeenCalled();
});
