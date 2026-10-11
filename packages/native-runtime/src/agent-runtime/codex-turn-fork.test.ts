import { describe, expect, it, vi } from "vitest";
import { CodexRuntimeAdapter, codexTurnsToMessages } from "./codex-runtime-adapter.js";

function fixture(ignorePoint = false) {
  const turns = [1, 2, 3].map((n) => ({ id: `turn-${n}`, status: n === 3 ? "inProgress" : "completed", items: [
    { type: "userMessage", id: `u${n}`, content: [{ type: "text", text: `question ${n}` }] },
    { type: "agentMessage", id: `a${n}`, text: `answer ${n}`, phase: "final_answer" },
  ] }));
  const source = { id: "source", name: "original", preview: "", cwd: "/repo", createdAt: 1, updatedAt: 1, status: { type: "active" }, source: "cli", path: null, turns };
  const request = vi.fn(async (method: string, params: any) => {
    if (method === "thread/read") return { thread: source };
    if (method === "thread/fork") return { thread: { ...source, id: "fork", turns: ignorePoint ? turns : turns.slice(0, turns.findIndex((t) => t.id === params.lastTurnId) + 1) } };
    return {};
  });
  const adapter = new CodexRuntimeAdapter({ client: { request, onNotification: () => () => {}, onExit: () => () => {}, setServerRequestHandler: () => {} } as never });
  return { turns, request, adapter };
}

describe("Codex fork through a completed turn", () => {
  it("forks through the selected second turn while leaving the running third turn in the source", async () => {
    const { adapter, request } = fixture();
    await expect(adapter.fork("source", { turnId: "turn-2" })).resolves.toMatchObject({ nativeSessionId: "fork", title: "original（副本）" });
    expect(request).toHaveBeenCalledWith("thread/fork", { threadId: "source", lastTurnId: "turn-2" });
    expect(request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });
  it.each(["missing", "turn-3"])("rejects %s before creating a copy", async (turnId) => {
    const { adapter, request } = fixture();
    await expect(adapter.fork("source", { turnId })).rejects.toThrow();
    expect(request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
  });
  it("rejects and archives a copy from a runtime that ignores the boundary", async () => {
    const { adapter, request } = fixture(true);
    await expect(adapter.fork("source", { turnId: "turn-1" })).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    expect(request).toHaveBeenCalledWith("thread/archive", { threadId: "fork" });
  });
  it("restores native points on completed answers only", async () => {
    const { turns } = fixture();
    const messages = await codexTurnsToMessages(turns as never);
    expect(messages.filter((m) => m.role === "assistant").map((m) => m.presentation?.forkPoint)).toEqual([
      { turnId: "turn-1" }, { turnId: "turn-2" }, undefined,
    ]);
  });
});
