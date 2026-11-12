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
import { renderContextHandoff } from "../../domain/engine-switch/handoff-renderer.js";
import type {
  ContextHandoff,
  EngineSwitchCreatedSession,
  EngineSwitchRecord,
  EngineSwitchSessionView,
  EngineSwitchThread,
  HandoffStrategy,
} from "../../domain/engine-switch/entities.js";
import type { EngineSwitchRepository } from "../../domain/engine-switch/EngineSwitchRepository.js";
import type { EngineSwitchRuntime } from "../../domain/engine-switch/EngineSwitchRuntime.js";

export type EngineSwitchErrorCode =
  | "INVALID_SESSION_ID"
  | "SOURCE_NOT_FOUND"
  | "TARGET_NOT_NATIVE"
  | "RUNTIME_UNAVAILABLE"
  | "SESSION_OCCUPIED";

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

    if (targetAgentType === "customer-agent" || !NATIVE_ONLY.has(targetAgentType)) {
      throw new EngineSwitchError("TARGET_NOT_NATIVE", "目标必须是原生引擎");
    }

    // Availability gate: fail before mutating any state.
    const health = await runtime.health();
    const targetHealth = health.find((entry) => entry.agentType === targetAgentType);
    if (targetHealth && !targetHealth.available) {
      throw new EngineSwitchError(
        "RUNTIME_UNAVAILABLE",
        `目标引擎 ${targetAgentType} 不可用：${targetHealth.error ?? "unknown"}`,
      );
    }

    let source: EngineSwitchSessionView;
    try {
      source = await runtime.getSession(sourceSessionId);
    } catch {
      throw new EngineSwitchError("SOURCE_NOT_FOUND", "源会话不存在或无法读取");
    }

    // Turn boundary: never switch mid-turn.
    if (source.status === "running" || source.occupancy === "owned-externally") {
      throw new EngineSwitchError("SESSION_OCCUPIED", "源会话正在运行，请等待回合结束后再切换");
    }

    const threadKey = command.threadKey?.trim()
      || repository.records.threadOfSession(sourceSessionId)
      || `engine-thread:${sourceSessionId}`;
    const now = this.now();
    repository.threads.ensure({
      threadKey,
      currentSessionId: sourceSessionId,
      currentAgentType: source.agentType,
      created: repository.threads.get(threadKey)?.created ?? now,
      updated: now,
    });

    // Decide strategy: has this target engine participated in the thread before?
    const previous = command.clean
      ? null
      : repository.records.latestInvolving(threadKey, targetAgentType);
    const previousSessionId = previous
      ? previous.toAgentType === targetAgentType
        ? previous.toSessionId
        : previous.fromAgentType === targetAgentType
          ? previous.fromSessionId
          : null
      : null;

    let strategy: "resume" | "create" = previousSessionId ? "resume" : "create";
    let targetSession: EngineSwitchCreatedSession;
    if (strategy === "resume" && previousSessionId) {
      const resumed = await this.tryResume(runtime, previousSessionId, targetAgentType);
      if (resumed) {
        targetSession = resumed;
      } else {
        strategy = "create";
        targetSession = await this.createTarget(runtime, source, targetAgentType, threadKey);
      }
    } else {
      targetSession = await this.createTarget(runtime, source, targetAgentType, threadKey);
    }

    // Delta cursor lives in the source session's own history space: the last
    // time this exact session was bridged to the target agent. Only a handoff
    // the target actually consumed counts as "seen" — a pending or superseded
    // artifact must be re-rendered, otherwise repeated switches would drop
    // history that never reached the target.
    const priorBridge = strategy === "resume"
      ? repository.records.latestFromTo(sourceSessionId, targetAgentType)
      : null;
    const priorHandoff = priorBridge ? repository.handoffs.byRecord(priorBridge.id) : null;
    const sinceHistoryId = priorBridge && priorHandoff?.status === "consumed"
      ? priorBridge.coveredThroughHistoryId
      : null;
    const sourceMessages = sinceHistoryId
      ? source.messages.filter((message) => isAfterHistoryId(message, sinceHistoryId))
      : source.messages;
    const rendered = renderContextHandoff(
      sourceMessages,
      `${source.agentType} 会话 ${sourceSessionId}`,
      targetAgentType,
      { budgetTokens: command.budgetTokens },
    );

    const handoffStrategy: HandoffStrategy = strategy === "resume" ? "delta" : "full";
    const handoff: ContextHandoff = {
      id: this.newId(),
      threadKey,
      fromSessionId: sourceSessionId,
      fromAgentType: source.agentType,
      toSessionId: targetSession.id,
      toAgentType: targetAgentType,
      strategy: handoffStrategy,
      summaryText: rendered.summaryText,
      omittedHistoryIds: rendered.omittedHistoryIds,
      status: rendered.summaryText ? "pending" : "consumed",
      createdBy: "system",
      created: now,
      consumedAt: rendered.summaryText ? null : now,
    };

    const coveredThrough = source.messages[source.messages.length - 1]?.historyId ?? null;
    const record: EngineSwitchRecord = {
      id: this.newId(),
      threadKey,
      fromSessionId: sourceSessionId,
      fromAgentType: source.agentType,
      toSessionId: targetSession.id,
      toAgentType: targetAgentType,
      strategy,
      handoffId: handoff.status === "pending" ? handoff.id : null,
      coveredThroughHistoryId: coveredThrough,
      at: now,
    };

    // One logical write: record + artifact + thread pointer. A thread has
    // exactly one active engine, so a newer handoff supersedes every pending
    // one in the thread — otherwise stale preambles could fire on the next run
    // of a member the thread already left.
    repository.records.append(record);
    if (handoff.status === "pending") {
      repository.handoffs.supersedePendingForThread(threadKey, now);
      repository.handoffs.insert(handoff);
    }
    repository.threads.setSession(threadKey, targetSession.id, targetAgentType);

    return {
      thread: repository.threads.get(threadKey) ?? {
        threadKey,
        currentSessionId: targetSession.id,
        currentAgentType: targetAgentType,
        created: now,
        updated: now,
      },
      record,
      handoff: handoff.status === "pending" ? handoff : null,
      targetSession,
      strategy,
    };
  }

  private async tryResume(
    runtime: EngineSwitchRuntime,
    sessionId: string,
    targetAgentType: AgentType,
  ): Promise<EngineSwitchCreatedSession | null> {
    try {
      const view = await runtime.getSession(sessionId);
      if (view.agentType !== targetAgentType) return null;
      return {
        id: view.id,
        agentType: view.agentType,
        title: view.title,
        cwd: view.cwd,
        ...(view.projectId ? { projectId: view.projectId } : {}),
      };
    } catch {
      return null;
    }
  }

  private async createTarget(
    runtime: EngineSwitchRuntime,
    source: EngineSwitchSessionView,
    targetAgentType: AgentType,
    threadKey: string,
  ): Promise<EngineSwitchCreatedSession> {
    const created = await runtime.createSession({
      agentType: targetAgentType,
      cwd: source.cwd,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      // Human-facing title: no thread keys or engine internals in the UI.
      title: source.title?.trim() ? `⤵ ${source.title.trim()}` : "⤵ 接续会话",
    });
    if (created.agentType !== targetAgentType) {
      throw new EngineSwitchError("RUNTIME_UNAVAILABLE", `Expected ${targetAgentType} session`);
    }
    return created;
  }
}

/**
 * historyIds are allocated monotonically by a source session (for example
 * `turn-3`). A message is "after" the cursor when its trailing sequence is
 * greater. Unparseable ids are included (fail toward more context).
 */
function isAfterHistoryId(message: { historyId?: string }, cursor: string): boolean {
  const cursorSeq = parseSeq(cursor);
  const seq = message.historyId ? parseSeq(message.historyId) : null;
  if (seq === null || cursorSeq === null) return true;
  return seq > cursorSeq;
}

function parseSeq(historyId: string): number | null {
  const match = /(?:^[-:]|[-_])(\d+)$/.exec(historyId);
  return match ? Number(match[1]) : null;
}
