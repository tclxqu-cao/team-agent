import { afterEach, expect, it, vi } from "vitest";
import { ChannelDelivery, messageText } from "./delivery";
import { messageFixture } from "../../../core/src/application/messaging/fixtures";
import type { DeliveryRecord } from "../../../core/src/domain/messaging/types";

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
