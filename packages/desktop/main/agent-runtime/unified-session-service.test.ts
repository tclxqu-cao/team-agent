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
  forkResult?: UnifiedSessionSummary;
  steerResult?: boolean;
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
    getSessionWatchPath: vi.fn(async (id: string) => `/sessions/${id}.jsonl`),
    create: vi.fn(async () => discovered[0]),
    async *run(): AsyncIterable<AgentEvent> {
      if (overrides.runError) throw overrides.runError;
      for (const event of overrides.events ?? [{ type: "done", finalText: "ok" }]) yield event;
    },
    ...(overrides.steerResult !== undefined
      ? { steer: vi.fn(async () => overrides.steerResult!) }
      : {}),
    abort: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => false),
    ...(overrides.forkResult ? { fork: vi.fn(async () => overrides.forkResult!) } : {}),
    ...(overrides.supportsDelete === false ? {} : { delete: vi.fn(async () => undefined) }),
    dispose: vi.fn(async () => undefined),
  };
  return build as unknown as AgentRuntimeAdapter;
}

describe("UnifiedSessionService", () => {
  it("resolves transcript watch paths through the owning adapter", async () => {
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo", "2026-01-02T00:00:00.000Z")]);
    const service = new UnifiedSessionService([codex], async () => []);

    await expect(service.getSessionWatchPath(encodeUnifiedSessionId("codex", "cx-1")))
      .resolves.toBe("/sessions/cx-1.jsonl");
    expect(codex.getSessionWatchPath).toHaveBeenCalledWith("cx-1");
  });

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

  it("reuses the complete detail cache for older-page projection", async () => {
    const codexSession = summary("codex", "cx-1", "/repo", "2026-01-02T00:00:00.000Z");
    const codex = adapter("codex", [codexSession]);
    const service = new UnifiedSessionService([codex], async () => []);

    await service.getUnpaginated(codexSession.id);
    await service.getUnpaginated(codexSession.id, true);

    expect(codex.getSession).toHaveBeenCalledTimes(1);
  });

  it("forwards image data URLs to the owning adapter in upload order", async () => {
    const codexSession = summary("codex", "cx-1", "/repo", "2026-01-02T00:00:00.000Z");
    const codex = adapter("codex", [codexSession]);
    const run = vi.fn(async function* (
      _nativeSessionId: string,
      _input: string,
      _images?: string[],
    ): AsyncIterable<AgentEvent> {
      yield { type: "done", finalText: "ok" };
    });
    codex.run = run;
    const service = new UnifiedSessionService([codex], async () => []);
    const images = ["data:image/png;base64,first", "data:image/jpeg;base64,second"];

    await drain(service.run(codexSession.id, "inspect", images));

    expect(run).toHaveBeenCalledWith("cx-1", "inspect", images, undefined, undefined);
  });

  it("forks through the owning adapter and invalidates discovery", async () => {
    const source = summary("codex", "cx-1", "/repo", "2026-01-02T00:00:00.000Z");
    const forked = summary("codex", "cx-fork", "/repo", "2026-01-03T00:00:00.000Z");
    const codex = adapter("codex", [source], { forkResult: forked });
    const service = new UnifiedSessionService([codex], async () => []);
    await service.list();

    await expect(service.fork(source.id)).resolves.toEqual(forked);
    await service.list();

    expect(codex.fork).toHaveBeenCalledWith("cx-1");
    expect(codex.discoverSessions).toHaveBeenCalledTimes(2);
  });

  it("rejects forks for runtimes without fork support", async () => {
    const claudeSession = summary("claude-code", "cc-1", "/repo", "2026-01-02T00:00:00.000Z");
    const claude = adapter("claude-code", [claudeSession]);
    const service = new UnifiedSessionService([claude], async () => []);

    await expect(service.fork(claudeSession.id)).rejects.toMatchObject({
      code: "OPERATION_NOT_SUPPORTED",
    });
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

  it("routes steering only while a supported runtime run is active", async () => {
    const claude = adapter(
      "claude-code",
      [summary("claude-code", "cc-1", "/repo", "2026-01-01T00:00:00.000Z")],
      { events: [{ type: "text_chunk", text: "slow" }], steerResult: true },
    );
    const service = new UnifiedSessionService([claude], async () => []);
    const id = encodeUnifiedSessionId("claude-code", "cc-1");

    await expect(service.steer(id, "before run")).resolves.toBe(false);
    const iterator = service.run(id, "start")[Symbol.asyncIterator]();
    await iterator.next();
    await expect(service.steer(id, "guide now")).resolves.toBe(true);
    expect(claude.steer).toHaveBeenCalledWith("cc-1", "guide now");
    await iterator.return?.();
  });

  it("rejects steering for runtimes without a steering adapter", async () => {
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo", "2026-01-01T00:00:00.000Z")]);
    const service = new UnifiedSessionService([codex], async () => []);

    await expect(service.steer(encodeUnifiedSessionId("codex", "cx-1"), "guide"))
      .rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
  });

  it("routes deletion through both native and customer-agent adapters", async () => {
    const ca = adapter("customer-agent", [summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z")]);
    const codex = adapter("codex", [summary("codex", "cx-1", "/repo", "2026-01-02T00:00:00.000Z")], {
      supportsDelete: true,
    });
    const service = new UnifiedSessionService([ca, codex], async () => []);

    await expect(service.delete(encodeUnifiedSessionId("codex", "cx-1"))).resolves.toBeUndefined();
    expect(codex.delete).toHaveBeenCalledWith("cx-1");

    await expect(service.delete("ca-1")).resolves.toBeUndefined();
    expect(ca.delete).toHaveBeenCalledWith("ca-1");
  });

  it("rejects deleting a session while AgentRoam is running it", async () => {
    const ca = adapter("customer-agent", [
      summary("customer-agent", "ca-1", "/repo", "2026-01-01T00:00:00.000Z"),
    ], { events: [{ type: "text_chunk", text: "slow" }] });
    const service = new UnifiedSessionService([ca], async () => []);
    const iterator = service.run("ca-1", "keep running")[Symbol.asyncIterator]();
    await iterator.next();

    await expect(service.delete("ca-1")).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    expect(ca.delete).not.toHaveBeenCalled();
    await iterator.return?.();
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

  it("restores persisted drafts through their owning adapter", () => {
    const draft = summary("claude-code", "cc-draft", "/repo", "2026-01-03T00:00:00.000Z");
    const claude = adapter("claude-code", []);
    claude.restoreDraft = vi.fn();
    const service = new UnifiedSessionService([claude], async () => []);

    service.restoreDrafts([draft]);

    expect(claude.restoreDraft).toHaveBeenCalledWith(draft);
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
