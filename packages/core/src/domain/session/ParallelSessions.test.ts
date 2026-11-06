import { describe, expect, it, vi } from "vitest";
import { createParallelSessions, parallelAgentTypes } from "./ParallelSessions";

describe("independent Agent session creation", () => {
  const input = { title: "same question", cwd: "/repo", agentTypes: ["codex", "zcode"] as const };
  it("creates each Agent at the same cwd without requiring an existing Agent project", async () => {
    const create = vi.fn(async (agentType: "codex" | "zcode", title: string, cwd: string) => ({ id: `runtime:${agentType}:new`, agentType, title, cwd }));
    const save = vi.fn();
    const group = await createParallelSessions({ ...input, agentTypes: [...input.agentTypes] }, { create: create as never, remove: vi.fn(), save });
    expect(create.mock.calls).toEqual([["codex", "same question", "/repo"], ["zcode", "same question", "/repo"]]);
    expect(group.members.map(member => member.id)).toEqual(["runtime:codex:new", "runtime:zcode:new"]);
    expect(save).toHaveBeenCalledWith(group);
  });
  it("waits for every creation and removes only new empty sessions if one runtime fails", async () => {
    const remove = vi.fn().mockResolvedValue(undefined), save = vi.fn();
    await expect(createParallelSessions({ ...input, agentTypes: [...input.agentTypes] }, {
      create: async type => { if (type === "zcode") throw new Error("offline"); return { id: "created", agentType: type }; }, remove, save,
    })).rejects.toThrow("zcode：offline");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("created");
    expect(save).not.toHaveBeenCalled();
  });
  it("rolls back empty sessions if association persistence fails", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    await expect(createParallelSessions({ ...input, agentTypes: [...input.agentTypes] }, {
      create: async type => ({ id: type, agentType: type }), remove, save: () => { throw new Error("storage full"); },
    })).rejects.toThrow("storage full");
    expect(remove.mock.calls.flat()).toEqual(["codex", "zcode"]);
  });
  it.each([[], ["codex"], ["codex", "codex"], ["codex", "unknown"]].map(list => ({ list })))("rejects an invalid participant list $list", ({ list }) => {
    expect(() => parallelAgentTypes(list)).toThrow();
  });
});
