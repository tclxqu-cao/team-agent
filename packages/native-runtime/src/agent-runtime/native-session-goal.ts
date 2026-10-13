/** Runtime-owned goal state, distinct from AgentRoam's queued goals and Thread Goal. */
export interface NativeGoalRef {
  id: string;
  revision: number;
}

export interface NativeSessionGoal extends NativeGoalRef {
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  activation: "armed" | "disarmed";
  maxGoalRounds: number;
  roundsStarted: number;
  blockedReason?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
}

export type NativeGoalMutation =
  | { action: "create"; objective: string; maxGoalRounds?: number }
  | { action: "edit"; ref: NativeGoalRef; objective?: string; maxGoalRounds?: number }
  | { action: "pause" | "resume" | "complete" | "clear"; ref: NativeGoalRef };

/** Validate at every public boundary; revisions prevent overwriting another client's edit. */
export function parseNativeGoalMutation(value: unknown): NativeGoalMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("目标操作格式无效");
  const body = value as Record<string, unknown>;
  const action = body.action;
  if (!["create", "edit", "pause", "resume", "complete", "clear"].includes(String(action))) {
    throw new Error("不支持此目标操作");
  }
  let ref: NativeGoalRef | undefined;
  if (action !== "create") {
    const raw = body.ref as Partial<NativeGoalRef> | null | undefined;
    if (!raw || typeof raw.id !== "string" || !raw.id.trim() || raw.id.length > 256
      || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1) {
      throw new Error("目标版本无效，请刷新后重试");
    }
    ref = { id: raw.id, revision: Number(raw.revision) };
  }
  if (action !== "create" && action !== "edit") return { action: action as "pause" | "resume" | "complete" | "clear", ref: ref! };
  if (action === "create" || body.objective !== undefined) {
    if (typeof body.objective !== "string" || !body.objective.trim() || body.objective.length > 100_000) {
      throw new Error("请输入有效的目标内容（最多 100000 字符）");
    }
  }
  if (body.maxGoalRounds !== undefined && (!Number.isSafeInteger(body.maxGoalRounds) || Number(body.maxGoalRounds) < 1)) {
    throw new Error("目标轮数上限必须是正整数");
  }
  if (action === "edit" && body.objective === undefined && body.maxGoalRounds === undefined) throw new Error("请输入目标内容或轮数上限");
  const fields = {
    ...(typeof body.objective === "string" ? { objective: body.objective.trim() } : {}),
    ...(body.maxGoalRounds !== undefined ? { maxGoalRounds: Number(body.maxGoalRounds) } : {}),
  };
  return action === "create"
    ? { action, ...fields, objective: fields.objective! }
    : { action: "edit", ref: ref!, ...fields };
}
