import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentWorkspace } from "@agent/native-runtime";
import { RemovedWorkspaceStore } from "./removed-workspace-store";

const temporaryDirectories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "removed-workspace-"));
  temporaryDirectories.push(directory);
  const file = join(directory, "data", "removed.json");
  const workspace: AgentWorkspace = {
    agentType: "codex", workspaceId: "native:missing", name: "Missing",
    roots: [join(directory, "missing")], order: 0, source: "native",
  };
  return { directory, file, workspace, store: new RemovedWorkspaceStore(file) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("removed workspaces", () => {
  it("persists removal across clients while preserving native history and other Agents", () => {
    const { directory, file, workspace, store } = fixture();
    const history = join(directory, "session.jsonl");
    writeFileSync(history, "historical conversation");
    const other = { ...workspace, agentType: "claude-code" as const };
    store.remove(workspace);

    expect(new RemovedWorkspaceStore(file).visible([workspace, other])).toEqual([other]);
    expect(new RemovedWorkspaceStore(file).visible([{ ...workspace, roots: [directory] }])).toHaveLength(1);
    expect(readFileSync(history, "utf8")).toBe("historical conversation");
  });

  it("rejects valid, partially valid, and virtual directories", () => {
    const { directory, workspace, store } = fixture();
    for (const roots of [[directory], [workspace.roots[0]!, directory], []]) {
      expect(() => store.remove({ ...workspace, roots })).toThrow("目录仍然有效");
    }
    expect(store.visible([workspace])).toEqual([workspace]);
  });

  it("lets explicit reimport restore the directory without restoring another Agent's removal", () => {
    const { workspace, store } = fixture();
    const other = { ...workspace, agentType: "claude-code" as const };
    store.remove(workspace);
    store.remove(other);
    mkdirSync(workspace.roots[0]!);
    store.restore("codex", workspace.roots[0]!);
    expect(store.visible([workspace, other])).toEqual([workspace]);
  });
});
