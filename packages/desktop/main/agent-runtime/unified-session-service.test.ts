import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@agent/core";
import { decodeUnifiedSessionId, encodeUnifiedSessionId } from "./session-id.js";
import type {
  AgentRuntimeAdapter,
  AgentType,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
} from "./types.js";
import { UnifiedSessionService } from "./unified-session-service.js";

interface AdapterOverrides {
  events?: AgentEvent[];
  runError?: unknown;
  occupancy?: Record<string, UnifiedSessionSummary["occupancy"]>;
  canResume?: Record<string, boolean>;
  sessions?: UnifiedSessionSummary[];
  health?: Partial<Record<AgentType, unknown>>;
  supportsDelete?: boolean;
}

function summary(
  agentType: AgentType,
  nativeSessionId: string,
  cwd: string,
  updated: string,
  overrides: Partial<UnifiedSessionSummary> = {},
): UnifiedSessionSummary {
  return {
    id: agentType === "customer-agent" ? nativeSessionId : encodeUnifiedSessionId(agentType, nativeSessionId),
    agentType,
    nativeSessionId,
    title: nativeSessionId,
    cwd,
    created: updated,
    updated,
    status: "idle",
    occupancy: "available",
    sourceLabel: agentType,
    canResume: true,
    canDelete: agentType === "customer-agent",
    ...overrides,
  };
}

function detail(from: UnifiedSessionSummary): UnifiedSessionDetail {
  return { ...from, messages: [], events: [] };
}

function adapter(agentType: AgentType, discovered: UnifiedSessionSummary[], overrides: AdapterOverrides = {}): AgentRuntimeAdapter {
  const sessions = overrides.sessions ?? discovered;
  const build = {
    agentType,
    health: vi.fn(async () => {
      if (overrides.health && agentType in overrides.health) {
        const value = overrides.health[agentType];
        if (value instanceof Error) throw value;
      }
      return { agentType, available: true, label: agentType };
    }),
    discoverSessions: vi.fn(async () => discovered),
    getSession: vi.fn(async (id: string) => {
      const found = sessions.find((session) => session.nativeSessionId === id);
      if (!found) {
        throw new Error(`missing session ${id}`);
      }
      return detail({
        ...found,
        ...(overrides.occupancy?.[id] ? { occupancy: overrides.occupancy[id]! } : {}),
        ...(overrides.canResume?.[id] !== undefined ? { canResume: overrides.canResume[id]! } : {}),
      });
    }),
    create: vi.fn(async () => discovered[0]),
    async *run(): AsyncIterable<AgentEvent> {
      if (overrides.runError) throw overrides.runError;
      for (const event of overrides.events ?? [{ type: "done", finalText: "ok" }]) yield event;
    },
    abort: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => false),
    ...(overrides.supportsDelete === false ? {} : { delete: vi.fn(async () => undefined) }),
    dispose: vi.fn(async () => undefined),
  };
  return build as unknown as AgentRuntimeAdapter;
}

describe("UnifiedSessionService", () => {
  it("isolates runtime discovery failures, sorts results, and matches the most specific project", async () => {
    const ca = adapter("customer-agent", [summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z")]);
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo/packages/app", "2026-01-03T00:00:00.000Z")]);
    const claude = adapter("claude-code", []);
    claude.discoverSessions = vi.fn(async () => { throw new Error("unavailable"); });
    const service = new UnifiedSessionService([ca, codex, claude], async () => [
      { id: "root", description: "/repo" },
      { id: "app", description: "/repo/packages/app" },
    ]);

    const sessions = await service.list();
    expect(sessions.map((session) => session.nativeSessionId)).toEqual(["cx-1", "ca-1"]);
    expect(sessions[0].projectId).toBe("app");
    expect(sessions[1].projectId).toBe("root");
  });

  it("routes an encoded ID to exactly one adapter", async () => {
    const ca = adapter("customer-agent", [summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z")]);
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo", "2026-01-02T00:00:00.000Z")]);
    const service = new UnifiedSessionService([ca, codex], async () => []);

    const events: AgentEvent[] = [];
    for await (const event of service.run(encodeUnifiedSessionId("codex", "cx-1"), "hello")) events.push(event);
    expect(events).toEqual([{ type: "done", finalText: "ok" }]);
    expect(codex.getSession).toHaveBeenCalledWith("cx-1");
    expect(ca.getSession).not.toHaveBeenCalled();
  });

  it("keeps healthy runtimes listing when one discovery fails", async () => {
    const ca = adapter("customer-agent", [summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z")]);
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo", "2026-01-02T00:00:00.000Z")]);
    const claude = adapter("claude-code", []);
    claude.discoverSessions = vi.fn(async () => { throw new Error("claude exploded"); });

    const service = new UnifiedSessionService([ca, codex, claude], async () => []);
    await service.health();

    const sessions = await service.list();
    expect(sessions.map((session) => session.nativeSessionId)).toEqual(["cx-1", "ca-1"]);
    expect(service.getCachedHealth().find((entry) => entry.agentType === "claude-code")).toMatchObject({
      available: false,
      error: "claude exploded",
    });
  });

  it("records health failures per runtime without hiding healthy ones", async () => {
    const ca = adapter("customer-agent", [], { health: { "customer-agent": new Error("no cli") } });
    const codex = adapter("codex", []);
    const service = new UnifiedSessionService([ca, codex], async () => []);

    const health = await service.health();

    expect(health.find((entry) => entry.agentType === "customer-agent")).toMatchObject({
      available: false,
      error: "no cli",
    });
    expect(health.find((entry) => entry.agentType === "codex")?.available).toBe(true);
  });

  it("leaves sessions without a matching project unassigned", async () => {
    const codex = adapter("codex", [summary("codex", "cx-1", "/somewhere/else", "2026-01-01T00:00:00.000Z")]);
    const service = new UnifiedSessionService([codex], async () => [{ id: "root", description: "/repo" }]);

    const [session] = await service.list();

    expect(session.projectId).toBeUndefined();
  });

  it("does not treat a sibling directory prefix as a project match", async () => {
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo-other/app", "2026-01-01T00:00:00.000Z")]);
    const service = new UnifiedSessionService([codex], async () => [{ id: "root", description: "/repo" }]);

    const [session] = await service.list();

    expect(session.projectId).toBeUndefined();
  });

  it("filters by project and lists child sessions", async () => {
    const sessions = [
      summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z"),
      summary("customer-agent", "ca-2", "/repo", "2026-01-02T00:00:00.000Z", { parentSessionId: "ca-1" }),
    ];
    const ca = adapter("customer-agent", sessions);
    const service = new UnifiedSessionService([ca], async () => [{ id: "root", description: "/repo" }]);

    await expect(service.list("root")).resolves.toHaveLength(2);
    await expect(service.list("missing")).resolves.toHaveLength(0);
    await expect(service.listChildren("ca-1")).resolves.toEqual([
      expect.objectContaining({ nativeSessionId: "ca-2" }),
    ]);
  });

  it("refreshes a cached discovery result", async () => {
    const ca = adapter("customer-agent", [summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z")]);
    const service = new UnifiedSessionService([ca], async () => []);

    await service.list();
    ca.discoverSessions = vi.fn(async () => [
      summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z"),
      summary("customer-agent", "ca-2", "/repo", "2026-01-02T00:00:00.000Z"),
    ]);

    await expect(service.list()).resolves.toHaveLength(1);
    await expect(service.refresh()).resolves.toHaveLength(2);
  });

  it("treats a legacy customer-agent UUID as its own runtime", async () => {
    const ca = adapter("customer-agent", [summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z")]);
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo", "2026-01-02T00:00:00.000Z")]);
    const service = new UnifiedSessionService([ca, codex], async () => []);

    expect(service.agentTypeFor("ca-1")).toBe("customer-agent");
    expect(decodeUnifiedSessionId("ca-1")).toEqual({ agentType: "customer-agent", nativeSessionId: "ca-1" });

    for await (const _event of service.run("ca-1", "legacy call")) void _event;
    expect(ca.getSession).toHaveBeenCalledWith("ca-1");
    expect(codex.getSession).not.toHaveBeenCalled();
  });

  it("refuses to run a session owned by another client", async () => {
    const codex = adapter("codex", [
      summary("codex", "cx-1", "/repo", "2026-01-01T00:00:00.000Z", {
        occupancy: "owned-externally",
        canResume: false,
      }),
    ]);
    const service = new UnifiedSessionService([codex], async () => []);

    await expect(
      drain(service.run(encodeUnifiedSessionId("codex", "cx-1"), "hello")),
    ).rejects.toMatchObject({ name: "RuntimeSessionError", code: "SESSION_OCCUPIED" });

    const sessions = await service.list();
    expect(sessions[0].canResume).toBe(false);
  });

  it("refuses concurrent runs of the same session", async () => {
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo", "2026-01-01T00:00:00.000Z")], {
      events: [{ type: "text_chunk", text: "slow" }],
    });
    const service = new UnifiedSessionService([codex], async () => []);
    const id = encodeUnifiedSessionId("codex", "cx-1");

    const iterator = service.run(id, "first")[Symbol.asyncIterator]();
    await iterator.next();

    await expect(drain(service.run(id, "second"))).rejects.toMatchObject({
      name: "RuntimeSessionError",
      code: "SESSION_OCCUPIED",
    });

    await iterator.return?.();
    await expect(drain(service.run(id, "third"))).resolves.toEqual([{ type: "text_chunk", text: "slow" }]);
  });

  it("rejects deleting external sessions and allows customer-agent deletes", async () => {
    const ca = adapter("customer-agent", [summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z")]);
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo", "2026-01-02T00:00:00.000Z")], {
      supportsDelete: true,
    });
    const service = new UnifiedSessionService([ca, codex], async () => []);

    await expect(service.delete(encodeUnifiedSessionId("codex", "cx-1"))).rejects.toMatchObject({
      name: "RuntimeSessionError",
      code: "OPERATION_NOT_SUPPORTED",
    });
    expect(codex.delete).not.toHaveBeenCalled();

    await expect(service.delete("ca-1")).resolves.toBeUndefined();
    expect(ca.delete).toHaveBeenCalledWith("ca-1");
  });

  it("validates create payloads per runtime", async () => {
    const ca = adapter("customer-agent", [summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z")]);
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo", "2026-01-02T00:00:00.000Z")]);
    const service = new UnifiedSessionService([ca, codex], async () => []);

    await expect(service.create({ title: "x", cwd: "/repo", agentType: "codex" })).resolves.toBeDefined();
    await expect(service.create({ title: "x", cwd: "", agentType: "codex" })).rejects.toMatchObject({
      code: "INVALID_SESSION_ID",
    });
    await expect(service.create({ title: "x", cwd: "/repo", agentType: "claude-code" })).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
    await expect(service.create({ title: "x", cwd: "", agentType: "customer-agent" })).resolves.toBeDefined();
  });

  it("invalidates discovery after create and delete", async () => {
    const ca = adapter("customer-agent", [summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z")]);
    const service = new UnifiedSessionService([ca], async () => []);

    await expect(service.list()).resolves.toHaveLength(1);
    await service.create({ title: "new", cwd: "/repo", agentType: "customer-agent" });
    ca.discoverSessions = vi.fn(async () => [
      summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z"),
      summary("customer-agent", "ca-2", "/repo", "2026-01-02T00:00:00.000Z"),
    ]);

    await expect(service.list()).resolves.toHaveLength(2);
  });

  it("polls adapters for question answers and stops at the first hit", async () => {
    const ca = adapter("customer-agent", []);
    const codex = adapter("codex", []);
    (codex.answerQuestion as any) = vi.fn(async () => true);
    const service = new UnifiedSessionService([ca, codex], async () => []);

    await expect(service.answerQuestion("q-1", { answer: "允许一次" })).resolves.toBe(true);
    expect(ca.answerQuestion).toHaveBeenCalledWith("q-1", { answer: "允许一次" });
    expect(codex.answerQuestion).toHaveBeenCalledTimes(1);
  });

  it("routes abort to one session and falls back to every runtime", async () => {
    const ca = adapter("customer-agent", [summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z")]);
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo", "2026-01-02T00:00:00.000Z")]);
    const service = new UnifiedSessionService([ca, codex], async () => []);

    await service.abort(encodeUnifiedSessionId("codex", "cx-1"));
    expect(codex.abort).toHaveBeenCalledWith("cx-1");
    expect(ca.abort).not.toHaveBeenCalled();

    await service.abort();
    expect(ca.abort).toHaveBeenCalledWith("");
    expect(codex.abort).toHaveBeenCalledWith("");
  });

  it("passes runtime events through untouched and disposes every adapter", async () => {
    const events: AgentEvent[] = [
      { type: "text_chunk", text: "a" },
      { type: "tool_call", toolCall: { id: "t1", name: "Bash", arguments: {} } },
      { type: "done", finalText: "a" },
    ];
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo", "2026-01-01T00:00:00.000Z")], { events });
    const service = new UnifiedSessionService([codex], async () => []);

    await expect(drain(service.run(encodeUnifiedSessionId("codex", "cx-1"), "go"))).resolves.toEqual(events);

    await service.dispose();
    expect(codex.dispose).toHaveBeenCalled();
  });

  it("reports the owning runtime for encoded identifiers", () => {
    const service = new UnifiedSessionService([], async () => []);

    expect(service.agentTypeFor(encodeUnifiedSessionId("codex", "cx-1"))).toBe("codex");
    expect(service.agentTypeFor(encodeUnifiedSessionId("claude-code", "cc-1"))).toBe("claude-code");
    expect(service.agentTypeFor(encodeUnifiedSessionId("customer-agent", "ca-1"))).toBe("customer-agent");
  });
});

async function drain(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
