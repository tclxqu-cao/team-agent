import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import { groupSessionExecutionMessages } from "./session-execution-trace";
import { collectTurnArtifacts, collectTurnChanges, restoreOmittedPatchFiles, sessionTurnResults, turnResultMessages } from "./session-turn-results";

const user = (id: string): ChatMessage => ({ id, role: "user", content: id, timestamp: 0 });
const answer = (id: string, content = "已完成"): ChatMessage => ({ id, role: "assistant", content, timestamp: 1 });
const tools = (id: string, toolCalls: ChatMessage["toolCalls"]): ChatMessage => ({ ...answer(id, ""), toolCalls });

describe("turn results", () => {
  it("attaches to the completed reply and keeps queued and steered input out of turn boundaries", () => {
    const messages = [
      user("first"), tools("edit", [{ id: "1", name: "Edit", arguments: { file_path: "first.ts" }, result: "" }]),
      { ...user("steer"), isSteered: true }, answer("reply1"), user("second"), answer("reply2"),
      { ...user("queued"), isQueued: true },
    ];
    const results = sessionTurnResults(groupSessionExecutionMessages(messages, true), true);
    expect(results.map(({ sourceId, footerId }) => [sourceId, footerId])).toEqual([["first", "reply1"]]);
    expect(collectTurnChanges(results[0].messages, "/repo").map(change => change.path)).toEqual(["/repo/first.ts"]);
  });

  it("merges native segments into one result without borrowing the next round's files", () => {
    const carrier = (segmentIndex: number): ChatMessage => ({
      ...answer(`trace-${segmentIndex}`, ""), executionTrace: { turnId: "native", revision: "rev", segmentIndex },
    });
    const messages = [
      { ...user("first"), presentation: { executionTrace: { turnId: "native", segmentIndex: 0 } } }, carrier(0),
      { ...user("steer"), presentation: { executionTrace: { turnId: "native", segmentIndex: 1 } } }, carrier(1),
      { ...answer("final"), presentation: { agentMessagePhase: "final_answer" as const } },
      user("next"), answer("next-final"),
    ];
    const results = sessionTurnResults(messages, false);
    const history = new Map([["native", [0, 1].map(segmentIndex => ({
      ...tools(`tools-${segmentIndex}`, [{ id: String(segmentIndex), name: "write_file", arguments: { file_path: `file-${segmentIndex}` }, result: "" }]),
      presentation: { executionTrace: { turnId: "native", segmentIndex } },
    }))]]);
    expect(results.map(({ sourceId, footerId }) => [sourceId, footerId])).toEqual([["first", "final"], ["next", "next-final"]]);
    expect(collectTurnChanges(turnResultMessages(results[0], history), "/repo").map(change => change.path))
      .toEqual(["/repo/file-0", "/repo/file-1"]);
    expect(collectTurnChanges(turnResultMessages(results[1], history), "/repo")).toEqual([]);
  });

  it("uses the applied file list for partial patches and drops unsuccessful edits", () => {
    const patch = "--- good\n+++ good\n@@ -1 +1 @@\n-a\n+b\n--- bad\n+++ bad\n@@ -1 +1 @@\n-c\n+d";
    const messages = [tools("tools", [
      { id: "patch", name: "apply_patch", arguments: { patch }, result: "Applied patch to:\n/repo/good (1 hunk)\n\nErrors:\nFile not found: /repo/bad" },
      { id: "fail", name: "edit", arguments: { filePath: "failed" }, result: "rejected", isError: true },
      { id: "open", name: "edit", arguments: { filePath: "new.ts", oldString: "old", newString: "new" }, result: "" },
      { id: "pending", name: "write_file", arguments: { file_path: "pending" } },
    ])];
    const changes = collectTurnChanges(messages, "/repo");
    expect(changes.map(change => [change.path, change.stats])).toEqual([
      ["/repo/good", { added: 1, removed: 1 }],
      ["/repo/new.ts", { added: 1, removed: 1 }],
    ]);
    expect(changes[0].patch).not.toContain("bad");
  });

  it("keeps a named report while skipping source citations and paths inside command output", () => {
    const messages = [tools("tools", [
      { id: "check", name: "shell", arguments: { command: "npm run test:unit" }, result: "FAIL /repo/runner.log", isError: true },
    ]), answer("reply", "[验收报告](/repo/report.md) [源文件](/repo/code.ts:10)")];
    expect(collectTurnArtifacts(messages, [], "/repo")).toEqual([{ path: "/repo/report.md", label: "验收报告" }]);
  });

  it("recovers files omitted from a bounded Codex patch without loading unrelated tool bodies", async () => {
    const ref = { turnId: "turn", revision: "rev", byteSize: 10, itemId: "patch" };
    const first = { path: "first.ts", kind: "add", diff: "first" };
    const second = { path: "second.ts", kind: "add", diff: "second" };
    const messages = [tools("tools", [
      { id: "patch", name: "apply_patch", arguments: { changes: [first], fileChangeSummary: { operation: "add", fileCount: 2, lineStats: null } }, resultRef: ref },
      { id: "shell", name: "shell", arguments: { command: "npm test" }, resultRef: { ...ref, itemId: "shell" } },
    ])];
    const loads: string[] = [];
    const restored = await restoreOmittedPatchFiles(messages, async request => {
      loads.push(request.itemId);
      return { ...request, content: JSON.stringify([first, second]) };
    });
    expect(loads).toEqual(["patch"]);
    expect(collectTurnChanges(restored, "/repo").map(change => change.path)).toEqual(["/repo/first.ts", "/repo/second.ts"]);
  });
});
