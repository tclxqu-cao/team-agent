import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteParallelSessionStore } from "./SQLiteParallelSessionStore";
import { getDatabase } from "./SQLiteDatabase";
import type { ParallelSessionGroup } from "../domain/session/ParallelSessions";

describe("persistent parallel conversation associations", () => {
  it("reopens the same group from either native member, without storing transcripts", () => {
    const base = mkdtempSync(join(tmpdir(), "parallel-session-store-"));
    const group: ParallelSessionGroup = { id: "group", title: "question", cwd: "/repo", created: "now", members: [
      { id: "runtime:codex:a", agentType: "codex" }, { id: "runtime:zcode:b", agentType: "zcode" },
    ] };
    try {
      const store = new SQLiteParallelSessionStore(base);
      store.create(group);
      expect(new SQLiteParallelSessionStore(base).getForSession("runtime:zcode:b")).toEqual(group);
      expect(store.getForSession("runtime:codex:a")).toEqual(group);
      expect(store.getForSession("other")).toBeNull();
      expect(() => store.create({ ...group, id: "collision" })).toThrow();
      expect(getDatabase(base).db.prepare("SELECT id FROM parallel_session_groups").all()).toEqual([{ id: "group" }]);
    } finally { getDatabase(base).close(); rmSync(base, { recursive: true, force: true }); }
  });
});
