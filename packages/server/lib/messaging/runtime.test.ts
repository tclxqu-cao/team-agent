import { afterEach, expect, it, vi } from "vitest";
import type { MessageRecord } from "../../../core/src/domain/messaging/types";
import { messageFixture } from "../../../core/src/application/messaging/fixtures";
import { ServerMessagingRuntime } from "./runtime";

const { messageSnapshot } = vi.hoisted(() => ({ messageSnapshot: vi.fn() }));
vi.mock("../native-runtime-service", () => ({ getNativeRuntimeService: () => ({ messageSnapshot }) }));
vi.mock("../../app/api/agent-host", () => ({ agentHost: {} }));
afterEach(() => vi.clearAllMocks());

const record: MessageRecord = {
  id: "message", source: messageFixture(), receivedAt: "", updatedAt: "", revision: 0,
  routing: { status: "routed", mode: "model" },
  execution: { status: "running", sessionId: "session", lastSequence: 0 }, timeline: [],
};

it("does not announce a normalized cancelled done event as successful completion", async () => {
  messageSnapshot.mockResolvedValue({ item: { id: "queue", status: "cancelled" }, runId: "run", events: [
    { runId: "run", sequence: 1, event: { type: "done", finalText: "partial result", result: { status: "cancelled" } } },
  ] });
  const result = await new ServerMessagingRuntime().observe(record);
  expect(result.status).toBe("aborted");
  expect(result.events).toEqual([{ id: "run:1", sequence: 1, kind: "failed", text: "原会话执行已取消" }]);
});

it("preserves ordinary completion and detects explicit native cancellation", async () => {
  messageSnapshot.mockResolvedValueOnce({ item: { id: "queue", status: "completed" }, runId: "run", events: [
    { runId: "run", sequence: 2, event: { type: "done", finalText: "result" } },
  ] }).mockResolvedValueOnce({ item: { id: "queue", status: "cancelled" }, runId: "run", events: [
    { runId: "run", sequence: 3, event: { type: "error", code: "NATIVE_ABORTED", message: "aborted" } },
  ] });
  expect((await new ServerMessagingRuntime().observe(record)).events[0]).toMatchObject({ kind: "completed", text: "result" });
  expect((await new ServerMessagingRuntime().observe(record)).status).toBe("aborted");
});
