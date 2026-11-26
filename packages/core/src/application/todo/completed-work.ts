import type { TodoItem } from "../../domain/agent/entities";

export function normalizedTodoTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

// Accept a direct assertion naming the work. A plan, question, or generic
// success message contains no task identity and cannot settle a calendar item.
function declaredTitle(sentence: string): string | undefined {
  const text = sentence.trim().replace(/\*\*/g, "").replace(/[。.!！]$/, "").trim();
  const match = /^(.+?)(?:已经完成了?|已完成了?|完成了|做完了)$/.exec(text)
    ?? /^(?:已完成|已经完成)\s*[：:]?\s*(.+)$/.exec(text)
    ?? /^(.+?)\s+(?:is complete|is completed|is done)$/i.exec(text);
  return match?.[1]?.trim().replace(/^[「“](.+)[」”]$/u, "$1");
}

export function completedWorkTitles(input: string, finalText: string, plan: readonly TodoItem[]): string[] {
  if (/(?:不要|先别|暂缓|暂不|不必|不用|别).{0,16}(?:勾|更新|同步|标记|待办|日历)|(?:待办|日历).{0,8}(?:先别动|保持原样)|(?:do not|don't) (?:complete|check off|update|sync)/i.test(input)) return [];
  const titles = new Set<string>();
  // Interpret a standalone user confirmation or the first sentence of a report.
  // A question, correction or instruction later in the message is ambiguous.
  const [statement, ...rest] = input.trim().split(/[。！!\n]/u);
  const followup = rest.join(" ").trim();
  const userTitle = (!followup || /^(?:结论|结果|交付物|报告)(?:是|如下|[：:])/u.test(followup))
    ? declaredTitle(statement) : undefined;
  if (userTitle) titles.add(userTitle);
  const firstSentence = finalText.trim().split(/[。！!\n]/u, 1)[0];
  const delivered = declaredTitle(firstSentence);
  const requested = input.trim().replace(/[。！!.]$/u, "").replace(/^(?:请)?(?:帮我)?(?:完成|做一下|做个|做一项|做)?/u, "");
  if (delivered && normalizedTodoTitle(requested) === normalizedTodoTitle(delivered)) titles.add(delivered);
  for (const item of plan) if (item.status === "completed") titles.add(item.title);
  const unfinished = new Set(plan.filter(item => item.status !== "completed").map(item => normalizedTodoTitle(item.title)));
  return [...titles].filter(title => !unfinished.has(normalizedTodoTitle(title)));
}
