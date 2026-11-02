import { describe, expect, it, vi } from "vitest";
import type { CatalogSession } from "../../../core/src/domain/supervision/types";
import { loadAllSessions, orderAllSessions } from "./all-sessions";

const session = (id: string, agentType: CatalogSession["agentType"], status: CatalogSession["status"], updated = "2026-11-02T00:00:00Z"): CatalogSession => ({
  id, agentType, status, updated, title: id, cwd: `/work/${id}`, canResume: true,
});

describe("all Agent sessions", () => {
  it("puts running sessions before pinned idle ones and keeps recency within each group", () => {
    const rows = [session("pinned", "codex", "idle"), session("running-old", "opencode", "running", "2026-10-01"),
      session("running-new", "claude-code", "running"), session("idle", "customer-agent", "idle")];
    expect(orderAllSessions(rows, ["pinned"], []).map(row => row.id)).toEqual(["running-new", "running-old", "pinned", "idle"]);
    expect(rows[0].id).toBe("pinned");
    expect(orderAllSessions(rows, [], ["idle"])[0].id).toBe("idle");
  });

  it("reads every catalog page across Agents and deduplicates boundary entries", async () => {
    const first = session("first", "codex", "running");
    const other = session("other", "workbuddy", "idle");
    const read = vi.fn().mockResolvedValueOnce({ data: [first], nextCursor: "page2", total: 2 })
      .mockResolvedValueOnce({ data: [first, other], nextCursor: null, total: 2 });
    const seen = vi.fn();
    await loadAllSessions(read, new AbortController().signal, seen);
    expect(read.mock.calls).toEqual([[undefined], ["page2"]]);
    expect(seen).toHaveBeenLastCalledWith([first, other], 2);
  });

  it("rejects repeated cursors instead of loading forever", async () => {
    const read = vi.fn().mockResolvedValue({ data: [], nextCursor: "repeat", total: 1 });
    await expect(loadAllSessions(read, new AbortController().signal, vi.fn())).rejects.toThrow("分页已失效");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not publish a late response from an obsolete refresh", async () => {
    const controller = new AbortController();
    const seen = vi.fn();
    const read = async () => { controller.abort(); return { data: [], nextCursor: null, total: 0 }; };
    await expect(loadAllSessions(read, controller.signal, seen)).rejects.toThrow();
    expect(seen).not.toHaveBeenCalled();
  });
});
