import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteDatabase } from "./SQLiteDatabase";
import { SQLiteEngineSwitchRepository } from "./SQLiteEngineSwitchRepository";
import type { EngineSwitchRecord, EngineSwitchThread, ContextHandoff } from "../domain/engine-switch/entities";

const roots: string[] = [];
const databases: SQLiteDatabase[] = [];
function setup() {
  const path = mkdtempSync(join(tmpdir(), "engine-switch-")); roots.push(path);
  const db = new SQLiteDatabase(path); databases.push(db);
  return { db, repository: new SQLiteEngineSwitchRepository(db.db) };
}
afterEach(() => { databases.splice(0).forEach((db) => db.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
const thread: EngineSwitchThread = { threadKey: "t", currentSessionId: "b", currentAgentType: "claude-code", created: "now", updated: "now" };
const record: EngineSwitchRecord = { id: "r", threadKey: "t", fromSessionId: "a", fromAgentType: "codex", toSessionId: "b", toAgentType: "claude-code", strategy: "create", handoffId: "h", coveredThroughHistoryId: "uuid-9", at: "now", sourceSnapshot: [{ role: "user", content: "full" }], phaseMessages: [{ role: "user", content: "full", historyId: "a:phase:0" }] };
const handoff: ContextHandoff = { id: "h", threadKey: "t", fromSessionId: "a", fromAgentType: "codex", toSessionId: "b", toAgentType: "claude-code", strategy: "full", summaryText: "context", historyFile: "/tmp/full.json", images: ["data:image/png;base64,aA=="], includedHistoryIds: ["a:phase:0"], omittedHistoryIds: [], status: "pending", createdBy: "system", created: "now", consumedAt: null };

describe("engine switch SQLite persistence", () => {
  it("keeps paging boundaries in metadata without loading transcript or image payloads", () => {
    const { repository } = setup();
    repository.records.append({ ...record, sourceHistoryItemCount: 2, sourceHistoryLastId: "opaque-native-id" });
    repository.handoffs.insert(handoff);
    const [metadata] = repository.records.list("t", false);
    expect(metadata.sourceHistoryItemCount).toBe(2);
    expect(metadata.sourceHistoryLastId).toBe("opaque-native-id");
    expect(metadata.sourceSnapshot).toBeUndefined();
    expect(metadata.phaseMessages).toBeUndefined();
    expect(repository.handoffs.summariesForThread("t")).toEqual([{ summaryText: "context" }]);
  });
  it("persists exact snapshots, image delivery and recovery metadata atomically", () => {
    const { repository } = setup();
    expect(repository.acquire("t", "owner", Date.now() + 60_000)).toBe(true);
    expect(repository.acquire("t", "other", Date.now() + 60_000)).toBe(false);
    repository.commit({ thread, expectedSessionId: null, owner: "owner", record, handoff });
    expect(repository.records.list("t")).toEqual([record]);
    expect(repository.handoffs.pendingForSession("b")).toEqual(handoff);
    repository.release("t", "other"); expect(repository.isLocked("t")).toBe(true);
    repository.release("t", "owner"); expect(repository.isLocked("t")).toBe(false);
  });

  it("rolls back the pointer and supersession when a write fails", () => {
    const { repository, db } = setup();
    repository.threads.ensure({ ...thread, currentSessionId: "a" });
    repository.handoffs.insert(handoff);
    db.db.exec("CREATE TRIGGER reject_records BEFORE INSERT ON engine_switch_records BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
    repository.acquire("t", "owner", Date.now() + 60_000);
    expect(() => repository.commit({ thread, expectedSessionId: "a", owner: "owner", record, handoff: null })).toThrow();
    expect(repository.threads.get("t")?.currentSessionId).toBe("a");
    expect(repository.handoffs.pendingForSession("b")?.id).toBe("h");
    expect(repository.records.list("t")).toEqual([]);
  });

  it("imports old server ledgers once and never overwrites newer broker state", () => {
    const legacy = setup().repository, current = setup().repository;
    legacy.threads.ensure(thread); legacy.records.append(record); legacy.handoffs.insert(handoff);
    current.importLegacy(legacy);
    expect(current.handoffs.pendingForSession("b")).toEqual(handoff);
    current.threads.setSession("t", "c", "opencode");
    current.importLegacy(legacy);
    expect(current.threads.get("t")?.currentSessionId).toBe("c");
    expect(current.records.list("t")).toHaveLength(1);
  });
});
