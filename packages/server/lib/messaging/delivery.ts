import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChannelMessage, DeliveryRecord } from "../../../core/src/domain/messaging/types";

const run = promisify(execFile);
export function messageText(text: string, suffix = ""): string {
  const chars: string[] = []; let bytes = Buffer.byteLength(suffix);
  for (const character of text) {
    if (bytes + Buffer.byteLength(character) > 1850) break;
    chars.push(character); bytes += Buffer.byteLength(character);
  }
  return chars.join("") + (chars.length < [...text].length ? "\n…完整结果请在 AgentRoam 查看" : "") + suffix;
}
function cliJson(output: string): Record<string, unknown> {
  const value = JSON.parse(output.trim());
  if (Array.isArray(value.content)) {
    const text = value.content.find((item: { type: string }) => item.type === "text")?.text;
    if (text) return JSON.parse(text);
  }
  return value;
}
async function call(method: string, body: unknown) {
  const { stdout } = await run(process.env.AGENT_WECOM_CLI || "wecom-cli", ["msg", method, JSON.stringify(body)], { timeout: 20_000, maxBuffer: 2_000_000, windowsHide: true });
  return cliJson(stdout);
}
function localTime(date: Date) { return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date); }

export class ChannelDelivery {
  constructor(private readonly execute: typeof call = call) {}
  private chatCache: { expires: number; chats: Array<{ chat_id: string; chat_name: string }> } | null = null;
  private async origin(source: ChannelMessage): Promise<string> {
    if (source.channel !== "wecom") throw new Error("该来源尚未配置返回通道");
    // Local SQLite conversation IDs and official API chat IDs are different namespaces.
    if (!source.conversationName) throw new Error("原会话缺少名称，无法核对官方发送通道");
    if (!this.chatCache || this.chatCache.expires < Date.now()) {
      const chats: Array<{ chat_id: string; chat_name: string }> = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result = await this.execute("get_msg_chat_list", { begin_time: localTime(new Date(Date.now() - 6 * 86400_000)), end_time: localTime(new Date()), ...(cursor ? { cursor } : {}) });
        if (result.errcode !== 0) throw new Error("企微发送通道不可用：" + String(result.errmsg ?? result.errcode));
        chats.push(...(Array.isArray(result.chats) ? result.chats : []));
        const next = result.has_more && typeof result.next_cursor === "string" ? result.next_cursor : undefined;
        if (next && seen.has(next)) throw new Error("企微会话列表分页未推进");
        cursor = next; if (cursor) seen.add(cursor);
        if (seen.size > 100) throw new Error("企微会话列表超出核对范围");
      } while (cursor);
      this.chatCache = { chats, expires: Date.now() + 60_000 };
    }
    const matches = this.chatCache.chats.filter(chat => chat.chat_name === source.conversationName);
    if (matches.length !== 1) throw new Error(matches.length ? "发送通道中存在同名会话，需要核对后回传" : "发送通道没有找到原会话，请检查 wecom-cli 登录账号");
    const sent = new Date(source.occurredAt);
    if (!Number.isFinite(sent.getTime()) || sent.getTime() < Date.now() - 6 * 86400_000) throw new Error("原消息超出发送通道核对范围，请在原会话确认后回传");
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const originals = new Set([source.text, typeof source.raw.displayText === "string" ? source.raw.displayText : ""].map(normalize).filter(Boolean));
    let cursor: string | undefined; let verified = 0; const seen = new Set<string>();
    do {
      const response = await this.execute("get_message", { chat_type: 2, chatid: matches[0].chat_id,
        begin_time: localTime(new Date(sent.getTime() - 60_000)), end_time: localTime(new Date(Math.min(Date.now(), sent.getTime() + 60_000))),
        ...(cursor ? { cursor } : {}) });
      if (response.errcode !== 0) throw new Error("无法核对原消息：" + String(response.errmsg ?? response.errcode));
      for (const row of Array.isArray(response.messages) ? response.messages : []) {
        if (row.msgtype === "text" && row.send_time === localTime(sent) && typeof row.text?.content === "string"
          && originals.has(normalize(row.text.content))) verified++;
      }
      cursor = typeof response.next_cursor === "string" && response.next_cursor ? response.next_cursor : undefined;
      if (cursor && (seen.has(cursor) || seen.size >= 20)) throw new Error("原消息核对分页未完成，请核对发送通道");
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (verified !== 1) throw new Error("发送通道未唯一匹配原消息的内容和时间，暂缓回传");
    return matches[0].chat_id;
  }
  async send(delivery: DeliveryRecord, source: ChannelMessage): Promise<{ status: "sent" | "failed" | "unknown" | "blocked"; receipt?: string; error?: string }> {
    if (delivery.target.kind === "webhook") {
      let url: URL;
      try { url = new URL(delivery.target.address); } catch { return { status: "blocked", error: "回传地址无效" }; }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return { status: "blocked", error: "回传地址必须为 HTTP(S)，账号凭据请使用专用通道" };
      try {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": delivery.id },
          body: JSON.stringify({ id: delivery.id, event: delivery.event, messageId: delivery.messageId, text: delivery.text }), signal: AbortSignal.timeout(15_000), redirect: "error" });
        return response.ok ? { status: "sent", receipt: "HTTP " + response.status }
          : { status: response.status >= 500 || response.status === 408 ? "unknown" : "failed", error: "接收方返回 HTTP " + response.status };
      } catch { return { status: "unknown", error: "回传请求中断，无法确认接收方是否已收到" }; }
    }
    let chatid: string;
    try { chatid = delivery.target.kind === "origin" ? await this.origin(source) : delivery.target.address; }
    catch (error) { return { status: "blocked", error: error instanceof Error ? error.message : "发送通道未就绪" }; }
    const publicUrl = process.env.AGENT_PUBLIC_URL?.replace(/\/$/, "");
    const suffix = publicUrl ? "\n" + publicUrl + "/app/?view=messaging&message=" + encodeURIComponent(delivery.messageId) : "";
    try {
      const result = await this.execute("send_message", { chat_type: 2, chatid, msgtype: "text", text: { content: messageText(delivery.text, suffix) } });
      return result.errcode === 0 ? { status: "sent", receipt: JSON.stringify({ errcode: 0, errmsg: result.errmsg, chatid }) }
        : { status: "failed", error: "企微拒绝发送：" + String(result.errmsg ?? result.errcode) };
    } catch { return { status: "unknown", error: "企微发送调用中断，无法确认是否送达，请先核对原会话" }; }
  }
}
