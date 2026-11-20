import type { StreamEvent } from "../stores/agentStore";

export function updateSessionDesktopToolActivity(
  activity: ReadonlyMap<string, string>,
  sessionId: string,
  event: Pick<StreamEvent, "type" | "_nativeRunId" | "toolCall">,
): ReadonlyMap<string, string> {
  const runId = event._nativeRunId;
  if (!runId) return activity;
  const current = activity.get(sessionId);
  if (event.type === "tool_call") {
    const name = event.toolCall?.name;
    const code = event.toolCall?.arguments?.code;
    const isComputerTool = name === "cua_repl:js" || name === "mcp__cua_repl__js";
    if (isComputerTool && typeof code === "string" && code.trim() && current !== runId) {
      return new Map(activity).set(sessionId, runId);
    }
  } else if (current === runId && (event.type === "done" || event.type === "error" || event.type === "turn_aborted")) {
    const remaining = new Map(activity);
    remaining.delete(sessionId);
    return remaining;
  }
  return activity;
}
