import { describe, expect, it, vi } from "vitest";
import { loadSessionChangeHistory } from "../lib/session-change-history";

function page(path: string, cursor: string | null, revision = "same") {
  return {
    id: "session",
    messages: [
      { role: "user", content: path },
      { role: "assistant", toolCalls: [{ id: path, name: "write_file", arguments: { file_path: path } }] },
      { role: "tool", toolCallId: path, content: "" },
    ],
    history: { revision, nextCursor: cursor, hasMore: Boolean(cursor) },
  };
}

describe("session change history", () => {
  const getSessionToolResult = vi.fn();
  it("includes both older and current changes in their original order", async () => {
    const getSession = vi.fn().mockResolvedValueOnce(page("latest.txt", "next")).mockResolvedValueOnce(page("earlier.txt", null));
    const signal = new AbortController().signal;
    const changes = await loadSessionChangeHistory({ getSession, getSessionToolResult }, "session", "/repo", signal);
    expect(changes.map(change => change.path)).toEqual(["/repo/earlier.txt", "/repo/latest.txt"]);
    expect(getSession).toHaveBeenNthCalledWith(2, "session", { before: "next", limit: 100, view: "trace" }, { signal });
  });

  it("rejects data belonging to another session", async () => {
    const signal = new AbortController().signal;
    const getSession = vi.fn().mockResolvedValueOnce({ ...page("other.txt", null), id: "other" });
    await expect(loadSessionChangeHistory({ getSession, getSessionToolResult }, "session", "/repo", signal)).rejects.toThrow("会话记录不可用");
  });

  it("restarts from the newest page when a live update changes the revision between pages", async () => {
    const signal = new AbortController().signal;
    const getSession = vi.fn()
      .mockResolvedValueOnce(page("before-rewind.txt", "previous"))
      .mockResolvedValueOnce(page("unmatched.txt", null, "new"))
      .mockResolvedValueOnce(page("latest.txt", "next", "new"))
      .mockResolvedValueOnce(page("earlier.txt", null, "new"));
    const changes = await loadSessionChangeHistory({ getSession, getSessionToolResult }, "session", "/repo", signal);
    expect(changes.map(change => change.path)).toEqual(["/repo/earlier.txt", "/repo/latest.txt"]);
    expect(getSession).toHaveBeenNthCalledWith(3, "session", { before: undefined, limit: 100, view: "trace" }, { signal });
  });

  it("keeps the pages already read when an older page fails", async () => {
    const signal = new AbortController().signal;
    const progress = vi.fn();
    const getSession = vi.fn().mockResolvedValueOnce(page("latest.txt", "next"))
      .mockRejectedValueOnce(new Error("请求超时"));
    await expect(loadSessionChangeHistory({ getSession, getSessionToolResult }, "session", "/repo", signal, progress))
      .rejects.toThrow("请求超时");
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith([expect.objectContaining({ path: "/repo/latest.txt" })]);
  });

  it("bounds recovery when history changes again during the retry", async () => {
    const signal = new AbortController().signal;
    const getSession = vi.fn().mockResolvedValueOnce(page("latest.txt", "next"))
      .mockResolvedValueOnce(page("earlier.txt", null, "new"))
      .mockResolvedValueOnce(page("latest.txt", "next", "new"))
      .mockResolvedValueOnce(page("earlier.txt", null, "newer"));
    await expect(loadSessionChangeHistory({ getSession, getSessionToolResult }, "session", "/repo", signal)).rejects.toThrow("会话内容已更新");
    expect(getSession).toHaveBeenCalledTimes(4);
  });

  it("hydrates a frozen turn once across its user segments", async () => {
    const turnId = "engine-frozen:old:turn";
    const getSession = vi.fn().mockResolvedValueOnce({
      id: "session",
      messages: [0, 1].map(segmentIndex => ({ role: "user", content: "任务", presentation: { executionTrace: { turnId, segmentIndex } } })),
      history: { revision: "same", delivery: "core", hasMore: false },
    }).mockResolvedValueOnce({
      ...page("frozen.txt", null),
      history: { revision: "same", delivery: "trace" },
    });
    const changes = await loadSessionChangeHistory({ getSession, getSessionToolResult }, "session", "/repo", new AbortController().signal);
    expect(changes.map(change => change.path)).toEqual(["/repo/frozen.txt"]);
    expect(getSession).toHaveBeenCalledTimes(2);
  });
});
