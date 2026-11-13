import { describe, expect, it, vi } from "vitest";
import type { AgentType } from "../../domain/agent/agent-type.js";
import type { Message } from "../../domain/model/entities.js";
import type {
  ContextHandoff,
  EngineSwitchCreatedSession,
  EngineSwitchHealth,
  EngineSwitchRecord,
  EngineSwitchSessionView,
  EngineSwitchThread,
} from "../../domain/engine-switch/entities.js";
import type { EngineSwitchRepository } from "../../domain/engine-switch/EngineSwitchRepository.js";
import type { EngineSwitchRuntime } from "../../domain/engine-switch/EngineSwitchRuntime.js";
import { EngineSwitchError, SwitchEngineUseCase } from "./SwitchEngineUseCase.js";
import { EngineSwitchLedger } from "./EngineSwitchLedger.js";

// ── Fakes (in-memory repository + scripted runtime) ─────────────────────────

class InMemoryEngineSwitchRepository implements EngineSwitchRepository {
  private locks = new Map<string, string>();
  acquire(key: string, owner: string): boolean { if (this.locks.has(key)) return false; this.locks.set(key, owner); return true; }
  release(key: string, owner: string): void { if (this.locks.get(key) === owner) this.locks.delete(key); }
  isLocked(key: string): boolean { return this.locks.has(key); }
  commit(input: Parameters<EngineSwitchRepository["commit"]>[0]): void {
    if ((this.threads.get(input.thread.threadKey)?.currentSessionId ?? null) !== input.expectedSessionId) throw new Error("stale");
    this.threads.ensure(input.thread);
    this.records.append(input.record);
    this.handoffs.supersedePendingForThread(input.thread.threadKey, input.thread.updated);
    if (input.handoff) this.handoffs.insert(input.handoff);
  }
  private readonly threadStore = new Map<string, EngineSwitchThread>();
  private readonly recordStore: EngineSwitchRecord[] = [];
  private readonly handoffStore: ContextHandoff[] = [];

  readonly threads = {
    ensure: (thread: EngineSwitchThread): void => {
      const existing = this.threadStore.get(thread.threadKey);
      this.threadStore.set(thread.threadKey, { ...thread, created: existing?.created ?? thread.created });
    },
    get: (threadKey: string): EngineSwitchThread | null => this.threadStore.get(threadKey) ?? null,
    setSession: (threadKey: string, currentSessionId: string, currentAgentType: AgentType): void => {
      const thread = this.threadStore.get(threadKey);
      if (thread) this.threadStore.set(threadKey, { ...thread, currentSessionId, currentAgentType });
    },
    list: (): EngineSwitchThread[] => [...this.threadStore.values()],
  };

  readonly records = {
    append: (record: EngineSwitchRecord): void => { this.recordStore.push(record); },
    list: (threadKey: string): EngineSwitchRecord[] => this.recordStore.filter((record) => record.threadKey === threadKey),
    latestInvolving: (threadKey: string, agentType: AgentType): EngineSwitchRecord | null => {
      const matches = this.recordStore.filter((record) =>
        record.threadKey === threadKey && (record.toAgentType === agentType || record.fromAgentType === agentType));
      return matches.length ? matches[matches.length - 1] : null;
    },
    latestFromTo: (fromSessionId: string, toAgentType: AgentType): EngineSwitchRecord | null => {
      const matches = this.recordStore.filter((record) =>
        record.fromSessionId === fromSessionId && record.toAgentType === toAgentType);
      return matches.length ? matches[matches.length - 1] : null;
    },
    threadOfSession: (sessionId: string): string | null => {
      const matches = this.recordStore.filter((record) =>
        record.fromSessionId === sessionId || record.toSessionId === sessionId);
      return matches.length ? matches[matches.length - 1].threadKey : null;
    },
  };

  readonly handoffs = {
    insert: (handoff: ContextHandoff): void => { this.handoffStore.push(handoff); },
    pendingForSession: (toSessionId: string): ContextHandoff | null =>
      this.handoffStore.find((handoff) => handoff.toSessionId === toSessionId && handoff.status === "pending") ?? null,
    markConsumed: (id: string, consumedAt: string): void => {
      const handoff = this.handoffStore.find((entry) => entry.id === id);
      if (handoff) { handoff.status = "consumed"; handoff.consumedAt = consumedAt; }
    },
    supersedePendingForThread: (threadKey: string, at: string): void => {
      for (const handoff of this.handoffStore) {
        if (handoff.threadKey === threadKey && handoff.status === "pending") {
          handoff.status = "superseded";
          handoff.consumedAt = at;
        }
      }
    },
    byRecord: (recordId: string): ContextHandoff | null => {
      const record = this.recordStore.find((entry) => entry.id === recordId);
      if (!record?.handoffId) return null;
      return this.handoffStore.find((handoff) => handoff.id === record.handoffId) ?? null;
    },
  };
}

class FakeEngineSwitchRuntime implements EngineSwitchRuntime {
  sessions = new Map<string, EngineSwitchSessionView>();
  healthEntries: EngineSwitchHealth[] = [];
  createCalls: AgentType[] = [];

  async materializeHistory(): Promise<string> { return "/tmp/handoff/history.json"; }

  async health(): Promise<readonly EngineSwitchHealth[]> {
    return this.healthEntries;
  }

  async getSession(sessionId: string): Promise<EngineSwitchSessionView> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("session not found");
    return session;
  }

  async createSession(options: { agentType: AgentType; cwd: string; projectId?: string; title: string }): Promise<EngineSwitchCreatedSession> {
    this.createCalls.push(options.agentType);
    const id = `runtime:${options.agentType}:created-${this.createCalls.length}`;
    const session: EngineSwitchSessionView = {
      id,
      agentType: options.agentType,
      title: options.title,
      cwd: options.cwd,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      status: "idle",
      occupancy: "available",
      canResume: true,
      messages: [],
    };
    this.sessions.set(id, session);
    return { id, agentType: options.agentType, title: options.title, cwd: options.cwd, ...(options.projectId ? { projectId: options.projectId } : {}) };
  }
}

function message(role: Message["role"], content: string, historyId: string): Message {
  return { role, content, historyId };
}

function sessionView(
  id: string,
  agentType: AgentType,
  overrides: Partial<EngineSwitchSessionView> = {},
): EngineSwitchSessionView {
  return {
    id,
    agentType,
    title: `${agentType} session`,
    cwd: "/tmp/project",
    status: "idle",
    occupancy: "available",
    canResume: true,
    messages: [],
    ...overrides,
  };
}

function wiring(): {
  useCase: SwitchEngineUseCase;
  runtime: FakeEngineSwitchRuntime;
  repository: EngineSwitchRepository;
} {
  const runtime = new FakeEngineSwitchRuntime();
  const repository: EngineSwitchRepository = new InMemoryEngineSwitchRepository();
  const useCase = new SwitchEngineUseCase({ runtime, repository });
  return { useCase, runtime, repository };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SwitchEngineUseCase", () => {
  it("first switch to an engine creates a session with a full handoff", async () => {
    const { useCase, runtime } = wiring();
    runtime.sessions.set("runtime:codex:c1", sessionView("runtime:codex:c1", "codex", {
      messages: [message("user", "修复登录 bug", "seq-0"), message("assistant", "已改 auth.ts", "seq-1")],
    }));

    const result = await useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" });

    expect(result.strategy).toBe("create");
    expect(result.targetSession.agentType).toBe("claude-code");
    expect(result.handoff?.strategy).toBe("full");
    expect(result.handoff?.status).toBe("pending");
    expect(result.handoff?.summaryText).toContain("修复登录 bug");
    expect(runtime.createCalls).toEqual(["claude-code"]);
  });

  it("switching back resumes the previous engine session with a delta handoff", async () => {
    const { useCase, runtime } = wiring();
    runtime.sessions.set("runtime:codex:c1", sessionView("runtime:codex:c1", "codex", {
      messages: [message("user", "修复登录 bug", "seq-0")],
    }));
    const first = await useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" });
    const claudeId = first.targetSession.id;
    runtime.sessions.set(claudeId, sessionView(claudeId, "claude-code", {
      messages: [message("user", "补充了测试", "seq-0")],
    }));

    const back = await useCase.execute({ sourceSessionId: claudeId, targetAgentType: "codex" });

    expect(back.strategy).toBe("resume");
    expect(back.targetSession.id).toBe("runtime:codex:c1");
    expect(back.handoff?.strategy).toBe("delta");
    expect(back.handoff?.summaryText).toContain("补充了测试");
    expect(runtime.createCalls).toEqual(["claude-code"]);
  });

  it("clean=true forces a fresh session even when a previous one exists", async () => {
    const { useCase, runtime } = wiring();
    runtime.sessions.set("runtime:codex:c1", sessionView("runtime:codex:c1", "codex"));
    const first = await useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" });
    const clean = await useCase.execute({ sourceSessionId: first.targetSession.id, targetAgentType: "claude-code", clean: true });
    expect(clean.strategy).toBe("create");
    expect(runtime.createCalls).toEqual(["claude-code", "claude-code"]);
  });

  it("rejects switching while the source session is running (turn boundary)", async () => {
    const { useCase, runtime } = wiring();
    runtime.sessions.set("runtime:codex:c1", sessionView("runtime:codex:c1", "codex", { status: "running" }));
    await expect(useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" }))
      .rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
  });

  it("fails fast when the target engine is unavailable", async () => {
    const { useCase, runtime } = wiring();
    runtime.sessions.set("runtime:codex:c1", sessionView("runtime:codex:c1", "codex"));
    runtime.healthEntries = [{ agentType: "claude-code", available: false, label: "Claude Code", error: "binary missing" }];
    await expect(useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" }))
      .rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(runtime.createCalls).toEqual([]);
  });

  it("rejects customer-agent and unknown engines as targets", async () => {
    const { useCase } = wiring();
    await expect(useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "customer-agent" }))
      .rejects.toMatchObject({ code: "TARGET_NOT_NATIVE" });
  });

  it("reports a missing source session", async () => {
    const { useCase } = wiring();
    await expect(useCase.execute({ sourceSessionId: "runtime:codex:missing", targetAgentType: "claude-code" }))
      .rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });

  it("degrades to create when the previous native session no longer exists", async () => {
    const { useCase, runtime } = wiring();
    runtime.sessions.set("runtime:codex:c1", sessionView("runtime:codex:c1", "codex"));
    const first = await useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" });
    const back = await useCase.execute({ sourceSessionId: first.targetSession.id, targetAgentType: "codex" });
    runtime.sessions.delete(first.targetSession.id);
    const again = await useCase.execute({ sourceSessionId: back.targetSession.id, targetAgentType: "claude-code" });
    expect(again.strategy).toBe("create");
    expect(runtime.createCalls).toEqual(["claude-code", "claude-code"]);
  });

  it("records an auditable ledger entry with its handoff artifact", async () => {
    const { useCase, runtime, repository } = wiring();
    runtime.sessions.set("runtime:codex:c1", sessionView("runtime:codex:c1", "codex", {
      messages: [message("user", "要交接的历史", "seq-0")],
    }));
    await useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" });

    const ledger = new EngineSwitchLedger(repository);
    const { thread, records } = ledger.ledger("runtime:codex:c1");
    expect(thread).not.toBeNull();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      fromSessionId: "runtime:codex:c1",
      fromAgentType: "codex",
      toAgentType: "claude-code",
      strategy: "create",
    });
    expect(ledger.handoffForRecord(records[0].id)).not.toBeNull();
  });

  it("consumes a pending handoff exactly once", async () => {
    const { useCase, runtime, repository } = wiring();
    runtime.sessions.set("runtime:codex:c1", sessionView("runtime:codex:c1", "codex", {
      messages: [message("user", "上下文", "seq-0")],
    }));
    const result = await useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" });
    const ledger = new EngineSwitchLedger(repository);
    const target = result.targetSession.id;
    expect(ledger.pendingHandoff(target)).not.toBeNull();
    ledger.markHandoffConsumed(result.handoff!.id);
    expect(ledger.pendingHandoff(target)).toBeNull();
  });

  it("supersedes older pending handoffs when switching to the same target again", async () => {
    const { useCase, runtime, repository } = wiring();
    runtime.sessions.set("runtime:codex:c1", sessionView("runtime:codex:c1", "codex", {
      messages: [message("user", "第一段上下文", "seq-0")],
    }));
    const first = await useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" });
    const target = first.targetSession.id;
    // Switch again without consuming the first handoff.
    await useCase.execute({ sourceSessionId: first.targetSession.id, targetAgentType: "codex" });
    const second = await useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" });
    expect(second.handoff).not.toBeNull();
    const pending = repository.handoffs.pendingForSession(target);
    expect(pending?.id).toBe(second.handoff!.id);
    const ledger = new EngineSwitchLedger(repository);
    expect(ledger.handoffForRecord(first.record.id)?.status).toBe("superseded");
  });

  it("exposes EngineSwitchError for typed error handling", () => {
    const error = new EngineSwitchError("SESSION_OCCUPIED", "busy");
    expect(error.code).toBe("SESSION_OCCUPIED");
    expect(error.name).toBe("EngineSwitchError");
  });
  it("bridges the whole thread through an engine that has not had a turn", async () => {
    const { useCase, runtime } = wiring();
    runtime.sessions.set("a", sessionView("a", "codex", { messages: [message("user", "ORIGINAL", "opaque-9")] }));
    const ab = await useCase.execute({ sourceSessionId: "a", targetAgentType: "claude-code" });
    const bc = await useCase.execute({ sourceSessionId: ab.targetSession.id, targetAgentType: "opencode" });
    expect(bc.handoff?.summaryText).toContain("ORIGINAL");
    expect(bc.record.phaseMessages).toEqual([]);
  });

  it("does not parse native item suffixes when returning to a previous engine", async () => {
    const { useCase, runtime, repository } = wiring();
    runtime.sessions.set("a", sessionView("a", "codex", { messages: [message("assistant", "OLD", "turn1-item-9")] }));
    const ab = await useCase.execute({ sourceSessionId: "a", targetAgentType: "claude-code" });
    new EngineSwitchLedger(repository).markHandoffConsumed(ab.handoff!.id);
    await useCase.execute({ sourceSessionId: ab.targetSession.id, targetAgentType: "codex" });
    runtime.sessions.get("a")!.messages.push(message("assistant", "NEW", "turn2-item-1"));
    const again = await useCase.execute({ sourceSessionId: "a", targetAgentType: "claude-code" });
    expect(again.handoff?.summaryText).toContain("NEW");
    expect(again.handoff?.summaryText).not.toContain("OLD");
  });

  it("rejects stale members and preserves the pointer when target creation fails", async () => {
    const { useCase, runtime, repository } = wiring();
    runtime.sessions.set("a", sessionView("a", "codex"));
    const ab = await useCase.execute({ sourceSessionId: "a", targetAgentType: "claude-code" });
    await expect(useCase.execute({ sourceSessionId: "a", targetAgentType: "opencode" })).rejects.toMatchObject({ code: "STALE_THREAD" });
    vi.spyOn(runtime, "createSession").mockRejectedValue(new Error("unavailable"));
    await expect(useCase.execute({ sourceSessionId: ab.targetSession.id, targetAgentType: "opencode" })).rejects.toThrow("unavailable");
    expect(repository.threads.get(ab.thread.threadKey)?.currentSessionId).toBe(ab.targetSession.id);
    expect(repository.records.list(ab.thread.threadKey)).toHaveLength(1);
    expect(repository.isLocked(ab.thread.threadKey)).toBe(false);
  });

  it("refuses occupied targets and recreates targets that cannot resume", async () => {
    const { useCase, runtime } = wiring();
    runtime.sessions.set("a", sessionView("a", "codex"));
    const ab = await useCase.execute({ sourceSessionId: "a", targetAgentType: "claude-code" });
    runtime.sessions.get("a")!.status = "running";
    await expect(useCase.execute({ sourceSessionId: ab.targetSession.id, targetAgentType: "codex" })).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    Object.assign(runtime.sessions.get("a")!, { status: "idle", canResume: false });
    const back = await useCase.execute({ sourceSessionId: ab.targetSession.id, targetAgentType: "codex" });
    expect(back.strategy).toBe("create");
    expect(back.targetSession.id).not.toBe("a");
  });

  it("blocks unfinished work and concurrent switches without mutating history", async () => {
    const { useCase, runtime, repository } = wiring();
    runtime.sessions.set("a", sessionView("a", "codex", { switchBlockReason: "background work" }));
    await expect(useCase.execute({ sourceSessionId: "a", targetAgentType: "claude-code" })).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    runtime.sessions.get("a")!.switchBlockReason = undefined;
    let finish!: () => void;
    const original = runtime.createSession.bind(runtime);
    vi.spyOn(runtime, "createSession").mockImplementation(async (options) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return original(options);
    });
    const first = useCase.execute({ sourceSessionId: "a", targetAgentType: "claude-code" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(useCase.execute({ sourceSessionId: "a", targetAgentType: "opencode" })).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    finish();
    const result = await first;
    expect(repository.records.list(result.thread.threadKey)).toHaveLength(1);
  });

  it("keeps prior engines' work on a clean switch without recursively rendering old preambles", async () => {
    const { useCase, runtime } = wiring();
    runtime.sessions.set("a", sessionView("a", "codex", { messages: [message("user", "ORIGINAL_REQUIREMENT", "a-uuid")] }));
    const ab = await useCase.execute({ sourceSessionId: "a", targetAgentType: "claude-code" });
    runtime.sessions.get(ab.targetSession.id)!.messages = [message("user", `${ab.handoff!.summaryText}\n\n[agentroam:current-user-message]\nB_WORK`, "b-uuid")];
    const fresh = await useCase.execute({ sourceSessionId: ab.targetSession.id, targetAgentType: "codex", clean: true });
    expect(fresh.handoff?.summaryText).toContain("B_WORK");
    expect(fresh.handoff?.summaryText.split("ORIGINAL_REQUIREMENT")).toHaveLength(2);
    expect(fresh.record.phaseMessages?.[0].content).toBe("B_WORK");
    expect(fresh.targetSession.id).not.toBe("a");
  });

});
