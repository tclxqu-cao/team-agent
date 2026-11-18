export interface WorkspaceChange {
  path: string;
  status: "modified" | "added" | "deleted" | "untracked" | "conflict";
  /** null means Git has no text line count (binary or untracked content). */
  added: number | null;
  removed: number | null;
}

export interface WorkspaceChanges {
  repository: boolean;
  root: string | null;
  branch: string | null;
  files: WorkspaceChange[];
}
