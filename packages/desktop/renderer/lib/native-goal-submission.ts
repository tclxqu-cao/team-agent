import type { NativeGoalMutation, NativeSessionGoal } from "../global";

/** Only explicit slash commands interpret control words; ordinary goals keep their text. */
export function nativeGoalSubmission(text: string, current: NativeSessionGoal | null): NativeGoalMutation | "show" {
  const slash = text.match(/^\/goal(?:\s+([\s\S]+))?$/i);
  const input = slash ? slash[1]?.trim() ?? "" : text.trim();
  if (slash && !input) return "show";
  const control = slash ? input.toLowerCase() : "";
  const ref = current ? { id: current.id, revision: current.revision } : null;
  if (["pause", "resume", "clear", "complete"].includes(control)) {
    if (!ref) throw new Error("当前没有目标");
    return { action: control as "pause" | "resume" | "clear" | "complete", ref };
  }
  if (slash && /^edit(?:\s|$)/i.test(input)) {
    if (!ref) throw new Error("当前没有可编辑的目标");
    const objective = input.slice(4).trim();
    if (!objective) throw new Error("请输入新的目标内容");
    return { action: "edit", ref, objective };
  }
  if (!input) throw new Error("请输入目标内容");
  return { action: "create", objective: input };
}
