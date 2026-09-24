import type { SessionActivity } from "@agent/core/domain/session/SessionActivity";

export type SidebarSessionVisualState =
  | "needs-input"
  | "running"
  | "completed"
  | "stale"
  | "error";

export function getSidebarSessionVisualState(activity: SessionActivity): SidebarSessionVisualState {
  if (activity === "idle") return "completed";
  return activity;
}

export const SIDEBAR_SESSION_STATUS_LABELS: Record<SidebarSessionVisualState, string> = {
  "needs-input": "需要输入",
  running: "运行中",
  completed: "执行完成",
  stale: "状态待刷新",
  error: "执行错误",
};
