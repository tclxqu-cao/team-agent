import { describe, expect, it, vi } from "vitest";
import { CodexDesktopContinuation } from "./codex-desktop-continuation.js";
import type { CodexDesktopConnection, DesktopThreadSnapshot, DesktopTurn } from "./codex-desktop-tools.js";

const user = (id: string, text: string) => ({ type: "userMessage", id, content: [{ type: "text", text }] });
const answer = (id: string, text: string, phase = "final_answer") => ({ type: "agentMessage", id, text, phase });
const snapshot = (...turns: DesktopTurn[]): DesktopThreadSnapshot => ({ thread: { id: "original", kind: "codex", status: { type: "active" } }, turns });
async function drain(run: AsyncIterable<unknown>) { const events = []; for await (const event of run) events.push(event); return events; }

describe("Desktop-owned original conversation", () => {
  it("waits for its own queued input, streams deltas once, and retains the native turn id", async () => {
    const old: DesktopTurn = { id: "old", status: "inProgress", items: [user("u0", "earlier"), answer("a0", "old answer")] };
    const next = (text: string, status = "inProgress"): DesktopTurn => ({ id: "new", status, items: [user("u1", "follow up"), answer("a1", text)] });
    const read = vi.fn().mockResolvedValueOnce(snapshot(old))
      .mockResolvedValueOnce(snapshot({ ...old, status: "completed" }))
      .mockResolvedValueOnce(snapshot(next("hel"), old))
      .mockResolvedValueOnce(snapshot(next("hel"), old))
      .mockResolvedValueOnce(snapshot(next("hello", "completed"), old));
    const send = vi.fn(); const close = vi.fn();
    const events = await drain(new CodexDesktopContinuation({ read, send, close }, 0).run("follow up", { brokerRunId: "run1", model: { id: "chosen" }, reasoningEffort: "high" }));
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("follow up", { callId: "run1", model: "chosen", thinking: "high" });
    expect(events.filter((event: any) => event.type === "text_chunk")).toEqual([
      { type: "text_chunk", text: "hel", itemId: "a1", turnId: "new", messagePhase: "final_answer" },
      { type: "text_chunk", text: "lo", itemId: "a1", turnId: "new", messagePhase: "final_answer" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", finalText: "hello", forkPoint: { turnId: "new" } });
    expect(close).toHaveBeenCalledOnce();
  });

  it("recognizes a new user message on the already running turn without replaying earlier output", async () => {
    const old: DesktopTurn = { id: "running", status: "inProgress", items: [user("u0", "follow up"), answer("a0", "previous", "commentary")] };
    const read = vi.fn().mockResolvedValueOnce(snapshot(old)).mockResolvedValueOnce(snapshot({
      ...old, status: "completed", items: [...old.items, user("u1", "follow up"), answer("a1", "new response")],
    }));
    const events = await drain(new CodexDesktopContinuation({ read, send: vi.fn(), close: vi.fn() }, 0).run("follow up"));
    expect(events.filter((event: any) => event.type === "text_chunk")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", finalText: "new response", forkPoint: { turnId: "running" } });
  });

  it("never resends a message after an ambiguous delivery failure", async () => {
    const connection: CodexDesktopConnection = { read: vi.fn().mockResolvedValue(snapshot()), send: vi.fn().mockRejectedValue(new Error("ack lost")), close: vi.fn() };
    const events = await drain(new CodexDesktopContinuation(connection, 0).run("follow up"));
    expect(connection.send).toHaveBeenCalledOnce();
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "DESKTOP_DELIVERY_UNCONFIRMED" })]);
    expect(events.some((event: any) => event.type === "done")).toBe(false);
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("reports original-client failure instead of treating old completed turns as success", async () => {
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot({ id: "new", status: "failed", error: { message: "native error" }, items: [user("u1", "follow up")] }));
    const events = await drain(new CodexDesktopContinuation({ read, send: vi.fn(), close: vi.fn() }, 0).run("follow up"));
    expect(events.at(-1)).toEqual({ type: "error", code: "NATIVE_PROTOCOL_ERROR", message: "native error" });
  });
});
