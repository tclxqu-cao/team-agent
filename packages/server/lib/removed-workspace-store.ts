import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentType, AgentWorkspace } from "@agent/native-runtime";
import { getServerBaseDir } from "./server-data-dir";

type RemovedWorkspace = Pick<AgentWorkspace, "agentType" | "workspaceId" | "roots">;

/** Sidebar removals belong to AgentRoam; native projects and session history remain intact. */
export class RemovedWorkspaceStore {
  constructor(private readonly filePath: string) {}

  private read(): RemovedWorkspace[] {
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as RemovedWorkspace[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private write(rows: RemovedWorkspace[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(rows), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }

  visible(workspaces: AgentWorkspace[]): AgentWorkspace[] {
    const removed = this.read();
    return workspaces.filter((workspace) => !removed.some((row) => (
      row.agentType === workspace.agentType
      && row.workspaceId === workspace.workspaceId
      && row.roots.length === workspace.roots.length
      && row.roots.every((root) => workspace.roots.includes(root))
    )));
  }

  remove(workspace: AgentWorkspace): void {
    if (workspace.roots.length === 0 || workspace.roots.some((root) => {
      try {
        return statSync(root).isDirectory();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return false;
        throw error;
      }
    })) {
      throw Object.assign(new Error("目录仍然有效，请刷新目录列表"), { status: 409 });
    }
    const rows = this.read().filter((row) => (
      row.agentType !== workspace.agentType || row.workspaceId !== workspace.workspaceId
    ));
    rows.push({ agentType: workspace.agentType, workspaceId: workspace.workspaceId, roots: workspace.roots });
    this.write(rows);
  }

  restore(agentType: AgentType, path: string): void {
    const rows = this.read();
    const remaining = rows.filter((row) => row.agentType !== agentType || !row.roots.includes(path));
    if (remaining.length !== rows.length) this.write(remaining);
  }
}

export function removedWorkspaceStore(): RemovedWorkspaceStore {
  return new RemovedWorkspaceStore(join(getServerBaseDir(), ".agent-data", "removed-workspaces.json"));
}
