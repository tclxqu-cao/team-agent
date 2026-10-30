import type { CollaborationMember } from "./types.js";

const BOUNDARY_BEFORE = "[\\s，。,.!?;；、:：)）\\]】>》]";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 解析消息里的 @提及（@成员名或 @成员ID）。要求 @ 前是空白或标点，避免误匹配邮箱等文本；
 * 长名优先消费匹配段，防止「@张三」命中「@张三丰」里的前缀。
 */
export function parseMentions(
  text: string,
  members: CollaborationMember[],
): CollaborationMember[] {
  const found: CollaborationMember[] = [];
  let rest = text;
  for (const member of [...members].sort(
    (a, b) => b.name.length - a.name.length,
  )) {
    const pattern = new RegExp(
      `(?:^|${BOUNDARY_BEFORE})@(?:${escapeRegExp(member.name)}|${escapeRegExp(member.id)})`,
    );
    const match = pattern.exec(rest);
    if (!match) continue;
    found.push(member);
    rest = rest.slice(0, match.index) + " " + rest.slice(match.index + match[0].length);
  }
  return found;
}

/** 去掉 @提及片段，剩余文本作为隐式任务的指令内容。 */
export function stripMentions(
  text: string,
  members: CollaborationMember[],
): string {
  let result = text;
  for (const member of [...members].sort(
    (a, b) => b.name.length - a.name.length,
  )) {
    result = result.replace(
      new RegExp(
        `(${BOUNDARY_BEFORE}|^)@(?:${escapeRegExp(member.name)}|${escapeRegExp(member.id)})`,
        "g",
      ),
      "$1",
    );
  }
  return result.replace(/[ \t]{2,}/g, " ").trim();
}
