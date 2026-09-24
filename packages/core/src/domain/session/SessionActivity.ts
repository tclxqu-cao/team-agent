export type SessionActivity = "needs-input" | "running" | "idle" | "stale" | "error";

export interface SessionActivityInput {
  authoritativeStatus: string;
  locallyRunning: boolean;
  needsInput: boolean;
  stale: boolean;
}

export function projectSessionActivity({
  authoritativeStatus,
  locallyRunning,
  needsInput,
  stale,
}: SessionActivityInput): SessionActivity {
  if (authoritativeStatus === "failed" || authoritativeStatus === "error") return "error";
  if (stale && !locallyRunning) return "stale";
  if (locallyRunning || authoritativeStatus === "running") {
    return needsInput ? "needs-input" : "running";
  }
  return "idle";
}

export function visibleWorkspaceIds(
  selectedProjectId: string | null,
  expandedProjectIds: Iterable<string>,
): string[] {
  const visible = new Set<string>();
  if (selectedProjectId) visible.add(selectedProjectId);
  for (const projectId of expandedProjectIds) {
    if (projectId) visible.add(projectId);
  }
  return [...visible];
}
