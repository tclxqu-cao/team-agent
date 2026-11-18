import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedSessionSummary } from "../global";
import { createAgentStore, useAgentStore, type AgentStore } from "../stores/agentStore";
import { useParallelSessions } from "./use-parallel-sessions";

const member = { id: "runtime:codex:scoped", agentType: "codex" } as UnifiedSessionSummary;
const message = { sourceMessageId: "first-message", content: "Keep this in my window", runOptions: { model: { id: "codex-test" } } };
const admitted = { active: null, queued: [], history: [] };

function captureHook(agentStore?: AgentStore) {
  let result!: ReturnType<typeof useParallelSessions>;
  function Harness() {
    result = useParallelSessions({ sessionId: null, agentStore, onQueueState: () => {} });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return result;
}

beforeEach(() => {
  useAgentStore.setState(createAgentStore().getState(), true);
  vi.stubGlobal("localStorage", undefined);
});
afterEach(() => {
  useAgentStore.setState(createAgentStore().getState(), true);
  vi.unstubAllGlobals();
});

describe("parallel messages in an isolated conversation", () => {
  it("keeps optimistic and admitted messages in the window's store", async () => {
    const scoped = createAgentStore();
    let resolveAdmission!: (state: typeof admitted) => void;
    const enqueueSessionMessage = vi.fn(() => new Promise<typeof admitted>(resolve => { resolveAdmission = resolve; }));
    vi.stubGlobal("window", { agentApi: { enqueueSessionMessage } });
    const hook = captureHook(scoped);
    const sending = hook.submit([{ member, message }]);

    expect(scoped.getState().getMessagesForSession(member.id)).toEqual([
      expect.objectContaining({ id: message.sourceMessageId, content: message.content, sendState: "pending" }),
    ]);
    expect(useAgentStore.getState().getMessagesForSession(member.id)).toEqual([]);
    await Promise.resolve();
    resolveAdmission(admitted);
    await expect(sending).resolves.toMatchObject({ accepted: [member.id], failed: [] });
    expect(scoped.getState().getMessagesForSession(member.id)[0].sendState).toBeUndefined();
    expect(useAgentStore.getState().getMessagesForSession(member.id)).toEqual([]);
  });

  it("marks a rejected message in the same store that displays the draft", async () => {
    const scoped = createAgentStore();
    vi.stubGlobal("window", { agentApi: { enqueueSessionMessage: vi.fn().mockRejectedValue(new Error("offline")) } });
    const hook = captureHook(scoped);
    const result = await hook.submit([{ member, message }]);

    expect(result.failed).toEqual([expect.objectContaining({ member, message, error: "offline" })]);
    expect(scoped.getState().getMessagesForSession(member.id)[0]).toMatchObject({
      id: message.sourceMessageId, content: message.content, sendState: "failed",
    });
    expect(useAgentStore.getState().getMessagesForSession(member.id)).toEqual([]);
  });

  it("retains the shared store for callers without a window-specific store", async () => {
    vi.stubGlobal("window", { agentApi: { enqueueSessionMessage: vi.fn().mockResolvedValue(admitted) } });
    const hook = captureHook();
    await hook.submit([{ member, message }]);
    expect(useAgentStore.getState().getMessagesForSession(member.id)).toEqual([
      expect.objectContaining({ id: message.sourceMessageId, content: message.content, sendState: undefined }),
    ]);
  });
});
