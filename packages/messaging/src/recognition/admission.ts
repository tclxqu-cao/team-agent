import type { ChannelMessage } from "../domain/types.js";

export function messageAdmission(source: ChannelMessage): { accepted: boolean; reason: string } {
  if (source.ownMessage) return { accepted: false, reason: "本人发送的消息，不触发派发" };
  if (source.conversationType === "direct") return { accepted: true, reason: "已接收私聊消息，等待判断" };
  return source.directMention ? { accepted: true, reason: "已接收正文直接 @本人的消息" }
    : { accepted: false, reason: "正文没有直接提及本人" };
}
