export type SidebarSessionVisualState =
  | "needs-input"
  | "running"
  | "completed"
  | "error";

interface SidebarSessionStatusInput {
  status: string;
  isRunning: boolean;
  needsInput: boolean;
}

export function getSidebarSessionVisualState({
  status,
  isRunning,
  needsInput,
}: SidebarSessionStatusInput): SidebarSessionVisualState {
  if (status === "failed" || status === "error") return "error";
  if (isRunning) return needsInput ? "needs-input" : "running";
  return "completed";
}

export const SIDEBAR_SESSION_STATUS_LABELS: Record<SidebarSessionVisualState, string> = {
  "needs-input": "需要输入",
  running: "运行中",
  completed: "执行完成",
  error: "执行错误",
};
