// ── Switch engine use case ──────────────────────────────────────────────────
//
// Application service implementing the two-strategy switch decision:
//
//   1. delta + resume  — the target engine previously had a session in this
//      logical thread: reuse that native session (its own native context is
//      still there) and bridge only what the target missed while inactive.
//   2. full + create   — no prior target session (or a clean switch was
//      requested): create a fresh target session with a budget-bounded full
//      history handoff.
//
// Invariants:
//   - the logical thread is the app-visible identity; native session ids are refs.
//   - every switch writes an auditable record + a materialized handoff artifact.
//   - handoff material is historical context, never a new instruction.
//   - a switch only happens at a turn boundary (no in-flight turn).

import type { AgentType } from "../../domain/agent/agent-type.js";
import { cleanEngineHistory, engineThreadPhases } from "../../domain/engine-switch/thread-history.js";
import { renderContextHandoff } from "../../domain/engine-switch/handoff-renderer.js";
import type {
  ContextHandoff,
  EngineSwitchCreatedSession,
  EngineSwitchRecord,
  EngineSwitchSessionView,
  EngineSwitchThread,
} from "../../domain/engine-switch/entities.js";
import type { EngineSwitchRepository } from "../../domain/engine-switch/EngineSwitchRepository.js";
import type { EngineSwitchRuntime } from "../../domain/engine-switch/EngineSwitchRuntime.js";

export type EngineSwitchErrorCode =
  | "INVALID_SESSION_ID"
  | "SOURCE_NOT_FOUND"
  | "TARGET_NOT_NATIVE"
  | "RUNTIME_UNAVAILABLE"
  | "SESSION_OCCUPIED"
  | "STALE_THREAD";

export class EngineSwitchError extends Error {
  constructor(readonly code: EngineSwitchErrorCode, message: string) {
    super(message);
    this.name = "EngineSwitchError";
  }
}

export interface SwitchEngineCommand {
  sourceSessionId: string;
  targetAgentType: AgentType;
  /** Logical thread key; defaults to the thread the source session belongs to. */
  threadKey?: string;
  /** Explicitly request a clean target context (force strategy "create"). */
  clean?: boolean;
  /** Handoff budget in tokens. */
  budgetTokens?: number;
}

export interface SwitchEngineResult {
  thread: EngineSwitchThread;
  record: EngineSwitchRecord;
  handoff: ContextHandoff | null;
  targetSession: EngineSwitchCreatedSession;
  strategy: "resume" | "create";
}

export interface SwitchEngineDeps {
  runtime: EngineSwitchRuntime;
  repository: EngineSwitchRepository;
  now?: () => string;
  newId?: () => string;
}

const NATIVE_ONLY: ReadonlySet<AgentType> = new Set<AgentType>([
  "codex",
  "claude-code",
  "opencode",
  "deepseek-harness",
  "qoder",
  "zcode",
  "workbuddy",
  "copilot",
]);

export class SwitchEngineUseCase {
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly deps: SwitchEngineDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  async execute(command: SwitchEngineCommand): Promise<SwitchEngineResult> {
    const { runtime, repository } = this.deps;
    const { sourceSessionId, targetAgentType } = command;
    if (!NATIVE_ONLY.has(targetAgentType)) throw new EngineSwitchError("TARGET_NOT_NATIVE", "目标必须是原生引擎");
    const existingKey = repository.records.threadOfSession(sourceSessionId);
    const threadKey = existingKey || `engine-thread:${sourceSessionId}`;
    if (command.threadKey && command.threadKey !== threadKey) throw new EngineSwitchError("INVALID_SESSION_ID", "会话不属于指定线程");
    const owner = this.newId();
    if (!repository.acquire(threadKey, owner, Date.now() + 300_000)) {
      throw new EngineSwitchError("SESSION_OCCUPIED", "此会话正在切换引擎，请稍后重试");
    }
    try {
      const existing = repository.threads.get(threadKey);
      if (existing && existing.currentSessionId !== sourceSessionId) {
        throw new EngineSwitchError("STALE_THREAD", `请从当前活动会话 ${existing.currentSessionId} 切换引擎`);
      }
      const health = await runtime.health();
      const targetHealth = health.find((entry) => entry.agentType === targetAgentType);
      if (targetHealth && !targetHealth.available) throw new EngineSwitchError("RUNTIME_UNAVAILABLE", `目标引擎不可用：${targetHealth.error ?? targetAgentType}`);
      let source: EngineSwitchSessionView;
      try { source = await runtime.getSession(sourceSessionId); }
      catch { throw new EngineSwitchError("SOURCE_NOT_FOUND", "源会话不存在或无法读取"); }
      this.assertIdle(source);
      if (source.agentType === targetAgentType && !command.clean) throw new EngineSwitchError("INVALID_SESSION_ID", "当前会话已在使用该引擎");
      const records = repository.records.list(threadKey);
      const handoffs = records.flatMap((record) => {
        const handoff = repository.handoffs.byRecord(record.id);
        return handoff ? [handoff] : [];
      });
      const legacy = new Map<string, EngineSwitchSessionView>();
      for (const record of records) {
        if (record.sourceSnapshot || legacy.has(record.fromSessionId)) continue;
        try { legacy.set(record.fromSessionId, await runtime.getSession(record.fromSessionId)); }
        catch { throw new EngineSwitchError("SOURCE_NOT_FOUND", "旧版线程历史无法读取，未执行切换"); }
      }
      const phases = engineThreadPhases(records, source, legacy, handoffs);
      const allMessages = phases.flatMap((phase) => phase.messages);
      const previous = command.clean ? null : repository.records.latestInvolving(threadKey, targetAgentType);
      const previousSessionId = previous
        ? previous.toAgentType === targetAgentType ? previous.toSessionId : previous.fromSessionId : null;
      let target: EngineSwitchCreatedSession | null = null;
      if (previousSessionId) {
        let view: EngineSwitchSessionView | null = null;
        try { view = await runtime.getSession(previousSessionId); } catch { /* deleted native session */ }
        if (view && view.agentType === targetAgentType) {
          this.assertIdle(view);
          if (view.canResume !== false && !view.readOnly && view.cwd === source.cwd) target = view;
        }
      }
      const strategy = target ? "resume" : "create";
      if (!target) target = await runtime.createSession({ agentType: targetAgentType, cwd: source.cwd,
        ...(source.projectId ? { projectId: source.projectId } : {}), title: source.title?.trim() || "接续会话" });
      if (target.agentType !== targetAgentType) throw new EngineSwitchError("RUNTIME_UNAVAILABLE", "目标引擎身份不匹配");
      const known = new Set<string>();
      if (strategy === "resume") {
        for (const phase of phases) if (phase.sessionId === target.id) {
          for (const message of phase.messages) if (message.historyId) known.add(message.historyId);
        }
        for (const handoff of handoffs) if (handoff.toSessionId === target.id && handoff.status === "consumed") {
          for (const id of handoff.includedHistoryIds ?? []) known.add(id);
        }
      }
      const candidates = allMessages.filter((message) => !message.historyId || !known.has(message.historyId));
      const id = this.newId();
      const workStateText = `工作目录：${source.cwd}\n${source.workStateText || "源会话当前没有运行中的回合。"}`;
      const historyFile = await runtime.materializeHistory({ id, messages: allMessages, workStateText });
      const rendered = renderContextHandoff(candidates, `${source.agentType} 会话 ${sourceSessionId}`, targetAgentType,
        { budgetTokens: command.budgetTokens, historyFile, workStateText });
      const now = this.now();
      const handoff: ContextHandoff = {
        id, threadKey, fromSessionId: sourceSessionId, fromAgentType: source.agentType,
        toSessionId: target.id, toAgentType: targetAgentType, strategy: strategy === "resume" ? "delta" : "full",
        summaryText: rendered.summaryText, historyFile, images: rendered.images,
        includedHistoryIds: rendered.includedHistoryIds, omittedHistoryIds: rendered.omittedHistoryIds,
        status: "pending", createdBy: "system", created: now, consumedAt: null,
      };
      const snapshot = cleanEngineHistory(source.messages, handoffs);
      const record: EngineSwitchRecord = {
        id: this.newId(), threadKey, fromSessionId: sourceSessionId, fromAgentType: source.agentType,
        toSessionId: target.id, toAgentType: targetAgentType, strategy, handoffId: id,
        coveredThroughHistoryId: source.messages.at(-1)?.historyId ?? null,
        sourceSnapshot: snapshot, phaseMessages: phases.at(-1)?.messages ?? [], at: now,
        sourceHistoryItemCount: source.historyItemCount,
        sourceHistoryLastId: source.historyLastId,
      };
      const thread: EngineSwitchThread = { threadKey, currentSessionId: target.id, currentAgentType: targetAgentType,
        created: existing?.created ?? now, updated: now };
      // No durable pointer or handoff changes until every external operation succeeds.
      try { repository.commit({ thread, expectedSessionId: existing?.currentSessionId ?? null, owner, record, handoff }); }
      catch { throw new EngineSwitchError("STALE_THREAD", "线程状态已变化，请刷新后重试"); }
      return { thread, record, handoff, targetSession: target, strategy };
    } finally { repository.release(threadKey, owner); }
  }

  private assertIdle(view: EngineSwitchSessionView): void {
    if (view.status === "running" || view.occupancy === "owned-externally" || view.switchBlockReason) {
      throw new EngineSwitchError("SESSION_OCCUPIED", view.switchBlockReason || "会话仍在运行或由其他客户端占用，请结束任务后切换");
    }
  }
}
