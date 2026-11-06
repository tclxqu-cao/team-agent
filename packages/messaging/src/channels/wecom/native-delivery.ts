import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveWecomAsset } from "./assets.js";
import type { ChannelMessage, DeliveryRecord, MessagingSettings } from "../../domain/types";

interface NativeResult { status: "sent" | "blocked" | "unknown"; receipt?: Record<string, unknown>; error?: string; submitted?: boolean }
type Invoke = (operation: "send" | "verify", request: Record<string, unknown>) => Promise<NativeResult>;
interface NativeDeliveryOptions {
  platform?: NodeJS.Platform;
  baseDir: string;
  settings: () => MessagingSettings["source"];
  refresh: () => Promise<void>;
  invoke?: Invoke;
  wait?: (milliseconds: number) => Promise<void>;
}

const invoke: Invoke = (operation, request) => new Promise((resolvePromise, reject) => {
  const child = execFile(process.env.AGENT_WECOM_PYTHON || "/usr/bin/python3", [resolveWecomAsset("native_sender.py"), operation],
    { timeout: 150_000, maxBuffer: 1_000_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }, (error, stdout) => {
      if (error) { reject(new Error("本地发送进程中断，请核对原会话")); return; }
      try {
        const result = JSON.parse(stdout) as NativeResult;
        if (!["sent", "blocked", "unknown"].includes(result.status)) throw new Error("invalid status");
        resolvePromise(result);
      } catch { reject(new Error("本地发送进程未返回有效结果")); }
    });
  child.stdin?.end(JSON.stringify(request));
});

export async function sendWecomNative(delivery: DeliveryRecord, source: ChannelMessage, text: string, options: NativeDeliveryOptions) {
  if ((options.platform ?? process.platform) !== "darwin") return { status: "blocked" as const, error: "本地企微发送桥目前仅支持 macOS" };
  if (delivery.target.kind !== "origin" || source.channel !== "wecom")
    return { status: "blocked" as const, error: "本地企微发送桥目前支持已采集的原会话回传" };
  const settings = options.settings();
  if (!settings.database || !settings.accountId || source.connectionId !== "wecom:" + settings.accountId)
    return { status: "blocked" as const, error: "发送账号与原消息的采集账号不一致" };
  if (!source.raw.LID || !source.raw.send_time || !source.conversationName || !source.senderId)
    return { status: "blocked" as const, error: "原消息缺少本地身份信息，请重新采集后回传" };
  const identity = createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 24);
  const request = {
    deliveryId: delivery.id, accountId: settings.accountId, clientDatabase: settings.database, text,
    target: { conversationId: source.conversationId, name: source.conversationName, conversationType: source.conversationType, peerUserId: source.peerUserId },
    origin: { lid: String(source.raw.LID), senderId: source.senderId, sendTime: String(source.raw.send_time), text: source.text },
    mirror: join(options.baseDir, ".agent-data/messaging-wecom", identity, "mirror.db"),
    stateDir: join(options.baseDir, ".agent-data/messaging-wecom-send"),
  };
  const call = options.invoke || invoke;
  let result: NativeResult;
  try { result = await call("send", request); }
  catch { return { status: "unknown" as const, error: "本地发送进程中断，无法确认是否已提交；不会自动重发" }; }
  if (result.status === "unknown") {
    const wait = options.wait || ((milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds)));
    // Verification shares the intake read without triggering routing or another send.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt) await wait(attempt * 1000);
        await options.refresh();
        const verified = await call("verify", request);
        if (verified.status === "sent") { result = verified; break; }
      } catch { /* An unavailable mirror cannot turn an uncertain submission into a retryable failure. */ }
    }
  }
  if (result.status === "sent") {
    const receipt = result.receipt;
    if (!receipt || receipt.transport !== "local-accessibility" || receipt.evidence !== "native-outgoing-record"
      || receipt.conversationId !== source.conversationId || receipt.senderId !== settings.accountId
      || !/^[1-9]\d*$/.test(String(receipt.rid)) || !/^[1-9]\d*$/.test(String(receipt.seq)) || receipt.flag !== 0)
      return { status: "unknown" as const, error: "发送组件缺少匹配账号和会话的有效回执；不会自动重发" };
  }
  return { status: result.status, ...(result.receipt ? { receipt: JSON.stringify(result.receipt) } : {}), ...(result.error ? { error: result.error } : {}) };
}
