import { afterEach, expect, it, vi } from "vitest";
import { sendWecomNative } from "./native-delivery";
import { messageFixture } from "../../testing/fixtures";
import type { DeliveryRecord } from "../../domain/types";

afterEach(() => vi.unstubAllGlobals());
const source = messageFixture({ channel: "wecom", connectionId: "wecom:99", conversationId: "12", conversationName: "蔡正银(zhengyin.cai)",
  conversationType: "direct", peerUserId: "zhengyin.cai", senderId: "12", text: "教教我", raw: { LID: "101", send_time: "100" } });
const delivery: DeliveryRecord = { id: "native-one", messageId: "message", eventId: "reply:message", event: "completed", purpose: "reply",
  target: { kind: "origin", address: "12", label: source.conversationName }, text: "你好", status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: "", updatedAt: "" };
const receipt = { transport: "local-accessibility", evidence: "native-outgoing-record", conversationId: "12", senderId: "99", rid: "202", seq: "11", flag: 0 };
const injectionReceipt = { ...receipt, transport: "local-injection" };
const options = () => ({ platform: "darwin" as const, baseDir: "/tmp/test-native", settings: () => ({ database: "/Profiles/own/Messages1/Info.db", accountId: "99" }),
  refresh: vi.fn().mockResolvedValue(undefined), wait: vi.fn().mockResolvedValue(undefined), invoke: vi.fn() });

it("refreshes the collector within the delivery tick and submits only once", async () => {
  const deps = options();
  deps.invoke.mockResolvedValueOnce({ status: "unknown", submitted: true })
    .mockResolvedValueOnce({ status: "unknown" }).mockResolvedValueOnce({ status: "sent", receipt });
  expect(await sendWecomNative(delivery, source, "你好", deps)).toEqual({ status: "sent", receipt: JSON.stringify(receipt) });
  expect(deps.invoke.mock.calls.map(call => call[0])).toEqual(["send", "verify", "verify"]);
  expect(deps.refresh).toHaveBeenCalledTimes(2);
  expect(deps.invoke.mock.calls[0][1]).toMatchObject({ deliveryId: "native-one", accountId: "99", clientDatabase: "/Profiles/own/Messages1/Info.db",
    target: { conversationId: "12", peerUserId: "zhengyin.cai" }, origin: { lid: "101", senderId: "12", sendTime: "100", text: "教教我" } });
});

it("blocks an account mismatch before starting a sending process", async () => {
  const deps = options();
  expect((await sendWecomNative(delivery, { ...source, connectionId: "wecom:other" }, "你好", deps)).status).toBe("blocked");
  expect(deps.invoke).not.toHaveBeenCalled();
});

it("requires the original native source identity and does not guess subscription IDs", async () => {
  const deps = options();
  expect((await sendWecomNative(delivery, { ...source, raw: {} }, "你好", deps)).status).toBe("blocked");
  expect((await sendWecomNative({ ...delivery, target: { kind: "wecom", address: "wr-official", label: "group" } }, source, "你好", deps)).status).toBe("blocked");
  expect(deps.invoke).not.toHaveBeenCalled();
});

it("keeps a controller timeout unknown and never invokes send again", async () => {
  const deps = options(); deps.invoke.mockRejectedValue(new Error("timeout"));
  expect((await sendWecomNative(delivery, source, "你好", deps)).status).toBe("unknown");
  expect(deps.invoke).toHaveBeenCalledTimes(1);
  expect(deps.refresh).not.toHaveBeenCalled();
});

it("keeps an unverified submission unknown when collection fails", async () => {
  const deps = options(); deps.invoke.mockResolvedValue({ status: "unknown", submitted: true }); deps.refresh.mockRejectedValue(new Error("permission"));
  expect((await sendWecomNative(delivery, source, "你好", deps)).status).toBe("unknown");
  expect(deps.invoke).toHaveBeenCalledTimes(1);
});

it("does not accept a claimed success with a missing or wrong-account receipt", async () => {
  const deps = options(); deps.invoke.mockResolvedValueOnce({ status: "sent" }).mockResolvedValueOnce({ status: "sent", receipt: { ...receipt, senderId: "other" } });
  expect((await sendWecomNative(delivery, source, "你好", deps)).status).toBe("unknown");
  expect((await sendWecomNative(delivery, source, "你好", deps)).status).toBe("unknown");
});

it("accepts strict injection receipts but rejects unknown transports and altered receipt guards", async () => {
  const deps = options();
  deps.invoke.mockResolvedValueOnce({ status: "sent", receipt: injectionReceipt });
  expect(await sendWecomNative(delivery, source, "你好", deps)).toEqual({ status: "sent", receipt: JSON.stringify(injectionReceipt) });
  for (const invalid of [{ ...receipt, transport: "legacy-name-only" }, { ...receipt, evidence: "claimed" },
    { ...receipt, conversationId: "13" }, { ...receipt, senderId: "other" }, { ...receipt, rid: "0" }, { ...receipt, seq: "-1" }, { ...receipt, flag: 1 }]) {
    const guarded = options(); guarded.invoke.mockResolvedValue({ status: "sent", receipt: invalid });
    expect((await sendWecomNative(delivery, source, "你好", guarded)).status).toBe("unknown");
  }
});

it("preserves pre-submission blocks without a receipt polling loop", async () => {
  const deps = options(); deps.invoke.mockResolvedValue({ status: "blocked", error: "已有草稿" });
  expect(await sendWecomNative(delivery, source, "你好", deps)).toEqual({ status: "blocked", error: "已有草稿" });
  expect(deps.refresh).not.toHaveBeenCalled();
});
