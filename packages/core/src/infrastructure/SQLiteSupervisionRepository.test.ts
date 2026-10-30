import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { groupFixture } from "../domain/collaboration/__tests__/fixtures.js";
import type { SupervisionState } from "../domain/supervision/types.js";
import { SQLiteSupervisionRepository } from "./SQLiteSupervisionRepository.js";
import { getDatabase } from "./SQLiteDatabase.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { getDatabase(dir).close(); rmSync(dir, { recursive: true, force: true }); } });
it("persists action receipts and isolates monitored targets from diagnostic session visibility", () => {
  const dir = mkdtempSync(join(tmpdir(), "supervision-store-")); dirs.push(dir);
  const repo = new SQLiteSupervisionRepository(dir);
  const group = groupFixture(); group.monitoring = { supervisorId: "a", targets: [{ id: "original", agentType: "codex", title: "原始", cwd: "/project" }] };
  const state: SupervisionState = { groupId: group.id, group, generation: 0, paused: false, updatedAt: "2026-10-28", cursors: {}, sessions: { "supervisor:a": "internal" }, incidents: [{ id: "action", groupId: "g", sessionId: "original", sessionTitle: "原始", fingerprint: "failure", kind: "recovery", status: "verifying", message: "核对中", createdAt: "2026-10-28", updatedAt: "2026-10-28", attempts: 1, receipt: { id: "receipt", accepted: true, runId: "resumed" } }] };
  repo.save(state);
  const reopened = new SQLiteSupervisionRepository(dir);
  expect(reopened.get("g")?.incidents[0].receipt?.runId).toBe("resumed");
  expect(reopened.internalSessionIds()).toEqual(new Set(["internal"]));
  expect(repo.save({ ...state, generation: 1, paused: true }, 0)).toBe(true);
  expect(reopened.save(state, 0)).toBe(false);
  expect(reopened.initialize(state).paused).toBe(true);
  expect(repo.claim("g", "host1", 100, 100)).toBe(true);
  expect(reopened.claim("g", "host2", 101, 100)).toBe(false);
  expect(repo.claimTarget("original", "group1", 100, 100)).toBe(true);
  expect(reopened.claimTarget("original", "group2", 101, 100)).toBe(false);
  expect(reopened.claimTarget("original", "group2", 201, 100)).toBe(true);
});
