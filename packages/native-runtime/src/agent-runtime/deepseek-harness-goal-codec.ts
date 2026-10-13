import { harnessRecord } from "./deepseek-harness-client.js";
import { RuntimeSessionError } from "./types.js";
import type { NativeSessionGoal } from "./native-session-goal.js";

/** Decode the native live view, including process-local continuation authority. */
export function decodeHarnessGoal(value: unknown): NativeSessionGoal | null {
  if (value === undefined || value === null) return null;
  const goal = harnessRecord(value);
  if (typeof goal.id !== "string" || !goal.id || !Number.isSafeInteger(goal.revision) || Number(goal.revision) < 1
    || typeof goal.objective !== "string" || !goal.objective.trim()
    || !["active", "paused", "blocked", "complete"].includes(String(goal.phase))
    || !["armed", "disarmed"].includes(String(goal.activation))
    || !Number.isSafeInteger(goal.maxGoalRounds) || Number(goal.maxGoalRounds) < 1
    || !Number.isSafeInteger(goal.roundsStarted) || Number(goal.roundsStarted) < 0
    || typeof goal.createdAt !== "number" || !Number.isFinite(goal.createdAt)
    || typeof goal.updatedAt !== "number" || !Number.isFinite(goal.updatedAt)) {
    throw new RuntimeSessionError("DeepSeek Harness 目标状态格式无效", "NATIVE_PROTOCOL_ERROR");
  }
  const reason = goal.blockedReason === undefined ? undefined : harnessRecord(goal.blockedReason);
  if (goal.phase === "blocked" && (!reason || typeof reason.code !== "string" || typeof reason.message !== "string")) {
    throw new RuntimeSessionError("DeepSeek Harness 目标缺少受阻原因", "NATIVE_PROTOCOL_ERROR");
  }
  return {
    id: goal.id, revision: Number(goal.revision), objective: goal.objective,
    phase: goal.phase as NativeSessionGoal["phase"], activation: goal.activation as NativeSessionGoal["activation"],
    maxGoalRounds: Number(goal.maxGoalRounds), roundsStarted: Number(goal.roundsStarted),
    createdAt: goal.createdAt, updatedAt: goal.updatedAt,
    ...(reason ? { blockedReason: { code: String(reason.code), message: String(reason.message) } } : {}),
  };
}
