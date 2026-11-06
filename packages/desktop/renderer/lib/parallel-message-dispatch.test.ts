import { describe, expect, it, vi } from "vitest";
import type { UnifiedSessionSummary } from "../global";
import { dispatchParallelMessages } from "./parallel-message-dispatch";

describe("parallel per-message routing", () => {
  const members = ["codex", "zcode", "claude-code"].map(agentType => ({ id: `runtime:${agentType}:one`, agentType })) as UnifiedSessionSummary[];
  const message = { sourceMessageId: "receipt", content: "same question", images: ["image"] };
  it("sends only to the explicitly selected subset", async () => {
    const enqueue = vi.fn().mockResolvedValue({ active: null, queued: [], history: [] });
    const result = await dispatchParallelMessages([members[0], members[2]].map(member => ({ member, message })), { enqueue });
    expect(enqueue.mock.calls.map(call => call[0])).toEqual([members[0].id, members[2].id]);
    expect(result.accepted).toHaveLength(2);
    expect(result.failed).toEqual([]);
  });
  it("retains successful admissions and retries only failed recipients with the same receipt", async () => {
    const enqueue = vi.fn().mockImplementation(async id => { if (id === members[1].id) throw new Error("offline"); return { active: null, queued: [], history: [] }; });
    const result = await dispatchParallelMessages(members.slice(0, 2).map(member => ({ member, message })), { enqueue });
    expect(result.accepted).toEqual([members[0].id]);
    expect(result.failed[0]).toMatchObject({ member: members[1], message, error: "offline" });
    enqueue.mockReset().mockResolvedValue({ active: null, queued: [], history: [] });
    await dispatchParallelMessages(result.failed, { enqueue });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(members[1].id, message);
  });
  it("isolates one Agent's catalog failure while another begins execution", async () => {
    const enqueue = vi.fn().mockResolvedValue({ active: null, queued: [], history: [] });
    const result = await dispatchParallelMessages(members.slice(0, 2).map(member => ({ member, message })), {
      enqueue, prepare: async (member, payload) => { if (member.agentType === "zcode") throw new Error("catalog unavailable"); return { ...payload, runOptions: { model: { id: "codex-own-model" } } }; },
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1].runOptions.model.id).toBe("codex-own-model");
    expect(result.failed[0].member.agentType).toBe("zcode");
  });
});
