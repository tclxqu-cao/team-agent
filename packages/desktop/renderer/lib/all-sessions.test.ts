import { describe, expect, it, vi } from "vitest";
import type { CatalogSession } from "../../../core/src/domain/supervision/types";
import { readSessionCatalogPage, mergeCatalogSessions, orderAllSessions } from "./all-sessions";

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

  it("loads only 20 summaries initially and requests the next page only on demand", async () => {
    const first = Array.from({ length: 20 }, (_, index) => session(`${index}`, "codex", "idle"));
    const second = Array.from({ length: 20 }, (_, index) => session(`${index + 20}`, "zcode", "idle"));
    const read = vi.fn().mockResolvedValueOnce({ data: first, nextCursor: "page2", total: 2367 })
      .mockResolvedValueOnce({ data: second, nextCursor: "page3", total: 2367 });
    const page = await readSessionCatalogPage(read, new AbortController().signal);
    expect(read.mock.calls).toEqual([[undefined]]);
    expect(page.data).toHaveLength(20);
    const next = await readSessionCatalogPage(read, new AbortController().signal, page.nextCursor!);
    expect(read.mock.calls).toEqual([[undefined], ["page2"]]);
    expect(mergeCatalogSessions(page.data, next.data)).toHaveLength(40);
  });

  it("deduplicates a boundary session and applies its latest summary", () => {
    const first = session("first", "codex", "idle");
    const other = session("other", "workbuddy", "idle");
    const updated = { ...first, status: "running" as const };
    expect(mergeCatalogSessions([first], [updated, other])).toEqual([updated, other]);
  });

  it("rejects repeated cursors instead of loading forever", async () => {
    const read = vi.fn().mockResolvedValue({ data: [], nextCursor: "repeat", total: 1 });
    await expect(readSessionCatalogPage(read, new AbortController().signal, "repeat")).rejects.toThrow("分页已失效");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not publish a late response from an obsolete refresh", async () => {
    const controller = new AbortController();
    const read = async () => { controller.abort(); return { data: [], nextCursor: null, total: 0 }; };
    await expect(readSessionCatalogPage(read, controller.signal)).rejects.toThrow();
  });

  it("does not issue a request after the page was hidden or its query was superseded", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn();
    await expect(readSessionCatalogPage(read, controller.signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});
