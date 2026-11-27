import type { CollaborationMember } from "./types.js";
/**
 * 解析消息里的 @提及（@成员名或 @成员ID）。要求 @ 前是空白或标点，避免误匹配邮箱等文本；
 * 长名优先消费匹配段，防止「@张三」命中「@张三丰」里的前缀。
 */
export declare function parseMentions(text: string, members: CollaborationMember[]): CollaborationMember[];
/** 去掉 @提及片段，剩余文本作为隐式任务的指令内容。 */
export declare function stripMentions(text: string, members: CollaborationMember[]): string;
//# sourceMappingURL=mention-routing.d.ts.map