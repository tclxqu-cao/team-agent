import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent/core";
import type { RpcNotification } from "./codex-app-server-client.js";
import { CodexRuntimeAdapter, codexTurnsToMessages } from "./codex-runtime-adapter.js";

const nativeActivity = (kind = "interacted") => ({
  type: "subAgentActivity",
  id: "call_2f20256edf5949bcbd5dc9e2f71ea16d",
  kind,
  agentThreadId: "01a1ec7f-fe88-7b31-9246-775dfa023beb",
  agentPath: "/root/question_card_ui",
  model: null,
  reasoningEffort: null,
});

const collabCall = (status = "completed") => ({
  type: "collabAgentToolCall",
  id: "collab-spawn",
  tool: "spawnAgent",
  status,
  senderThreadId: "parent-thread",
  receiverThreadIds: ["child-thread"],
  prompt: "Check the question card",
  model: "codex-test",
  reasoningEffort: "high",
  agentsStates: { "child-thread": { status: "running", message: null } },
});

function turn(items: Array<Record<string, unknown> & { type: string; id: string }>) {
  return { id: "turn-live", status: "completed", items };
}

function liveFixture(items: Array<{ method: string; item: ReturnType<typeof nativeActivity> | ReturnType<typeof collabCall> }>) {
  let notify: (message: RpcNotification) => void = () => undefined;
  const thread = {
    id: "parent-thread", parentThreadId: null, name: "Parent", preview: "Parent", createdAt: 1, updatedAt: 1,
    cwd: "/tmp", path: null, source: "desktop", status: { type: "idle" }, turns: [],
  };
  const client = {
    onNotification: (handler: typeof notify) => { notify = handler; return () => undefined; },
    onExit: () => () => undefined,
    setServerRequestHandler: () => undefined,
    request: async (method: string) => {
      if (method === "thread/read" || method === "thread/resume") return { thread };
      if (method === "turn/start") {
        queueMicrotask(() => {
          for (const { method: itemMethod, item } of items) {
            notify({ method: itemMethod, params: { threadId: thread.id, turnId: "turn-live", item } });
          }
          notify({ method: "turn/completed", params: { threadId: thread.id, turn: turn([]) } });
        });
        return { turn: { id: "turn-live" } };
      }
      if (method === "thread/unsubscribe") return {};
      throw new Error(`Unexpected request: ${method}`);
    },
  };
  const adapter = new CodexRuntimeAdapter({ client: client as never, sessionRoot: "/tmp" });
  return { adapter, thread };
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("Codex sub-agent history", () => {
  it.each(["started", "interacted", "interrupted", "completed"])("retains the native %s activity and identity", async kind => {
    const activity = nativeActivity(kind);
    const messages = await codexTurnsToMessages([turn([activity])]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      historyId: `codex-trace:turn-live:tool-call:${activity.id}`,
      toolCalls: [{ id: activity.id, name: "codex:subagentActivity", arguments: {
        kind, agentThreadId: activity.agentThreadId, agentPath: activity.agentPath,
      } }],
    });
    expect(messages[1]).toMatchObject({ role: "tool", toolCallId: activity.id });
    expect(JSON.parse(messages[1].content)).toEqual({ kind, agentThreadId: activity.agentThreadId, agentPath: activity.agentPath });
  });

  it("preserves creation metadata and supports lazy trace result loading", async () => {
    const activity = { ...nativeActivity("started"), model: "codex-test", reasoningEffort: "high" };
    const messages = await codexTurnsToMessages([turn([activity])], { toolResultMode: "lazy", revision: "revision-1" });
    expect(messages[0].toolCalls?.[0].arguments).toMatchObject({ model: "codex-test", reasoningEffort: "high" });
    expect(messages[1]).toMatchObject({
      role: "tool", content: "", toolCallId: activity.id,
      toolResultRef: { turnId: "turn-live", itemId: activity.id, revision: "revision-1" },
    });
  });

  it("keeps legacy collaboration targets, task text and agent states", async () => {
    const item = collabCall();
    const messages = await codexTurnsToMessages([turn([item])]);
    expect(messages[0].toolCalls).toEqual([{ id: item.id, name: "codex:spawnAgent", arguments: {
      senderThreadId: "parent-thread", receiverThreadIds: ["child-thread"], prompt: item.prompt,
      model: "codex-test", reasoningEffort: "high",
    } }]);
    expect(JSON.parse(messages[1].content)).toEqual({
      status: "completed", receiverThreadIds: ["child-thread"], agentsStates: item.agentsStates,
    });
  });

  it.each(["inProgress", "failed", "interrupted"])("represents legacy %s without inventing completion or failure", async status => {
    const messages = await codexTurnsToMessages([turn([collabCall(status)])]);
    expect(messages).toHaveLength(status === "inProgress" ? 1 : 2);
    if (status !== "inProgress") {
      const lazy = await codexTurnsToMessages([turn([collabCall(status)])], { toolResultMode: "lazy", revision: "r" });
      expect(lazy[1].toolResultRef?.isError).toBe(status === "failed");
    }
  });
});

describe("Codex live sub-agent activity", () => {
  it.each([false, true])("emits a visible call before a completion without duplicating started: %s", async includeStarted => {
    const item = nativeActivity();
    const notifications = [
      ...(includeStarted ? [{ method: "item/started", item }] : []),
      { method: "item/completed", item },
      { method: "item/completed", item },
    ];
    const { adapter, thread } = liveFixture(notifications);
    const events = await drain(adapter.run(thread.id, "Check the notification"));
    const tools = events.filter(event => event.type === "tool_call" || event.type === "tool_result");
    expect(tools).toEqual([
      expect.objectContaining({ type: "tool_call", turnId: "turn-live", toolCall: expect.objectContaining({ id: item.id, name: "codex:subagentActivity" }) }),
      expect.objectContaining({ type: "tool_result", turnId: "turn-live", result: expect.objectContaining({ toolCallId: item.id }) }),
    ]);
  });

  it("handles completion-only legacy calls and clears de-duplication between runs", async () => {
    const item = collabCall();
    const { adapter, thread } = liveFixture([{ method: "item/completed", item }]);
    for (let index = 0; index < 2; index += 1) {
      const events = await drain(adapter.run(thread.id, "Check again"));
      expect(events.filter(event => event.type === "tool_call")).toEqual([
        expect.objectContaining({ toolCall: expect.objectContaining({ id: item.id, name: "codex:spawnAgent" }) }),
      ]);
      expect(events.filter(event => event.type === "tool_result")).toHaveLength(1);
      expect(events.some(event => event.type === "error")).toBe(false);
    }
  });
});
