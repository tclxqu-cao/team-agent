import { describe, expect, it } from "vitest";
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
    await useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" });
    const clean = await useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code", clean: true });
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
    runtime.sessions.delete(first.targetSession.id);
    const again = await useCase.execute({ sourceSessionId: "runtime:codex:c1", targetAgentType: "claude-code" });
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
});
