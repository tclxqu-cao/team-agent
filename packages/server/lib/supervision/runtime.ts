import { z } from "zod";
import {
  type AgentEvent, type CollaborationGroup, type CollaborationMember, type InterventionReceipt,
  type MonitoredSession, type SessionObservation, type SupervisionDecision, type SupervisionIncident,
  type SupervisionRuntime, type SupervisionState, SQLiteSupervisionRepository,
} from "@agent/core";
import { supervisionPrompt } from "../../../core/src/application/supervision/prompts";
import { agentHost } from "../../app/api/agent-host";
import { ServerCollaborationRuntime } from "../collaboration/runtime";
import { getNativeRuntimeService, isNativeSessionId } from "../native-runtime-service";

const option = z.object({ label: z.string().min(1).max(200), description: z.string().max(2000) });
const reason = z.string().min(1).max(8000);
const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("observe"), reason }),
  z.object({ action: z.literal("complete"), reason }),
  z.object({ action: z.literal("continue"), reason, message: z.string().min(1).max(16000) }),
  z.object({ action: z.literal("handoff"), reason, message: z.string().min(1).max(16000), targetSessionId: z.string().min(1).max(400) }),
  z.object({ action: z.literal("decision"), reason, options: z.array(option).max(8).optional(), recommendation: z.string().max(4000).optional() }),
]);
function jsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  return JSON.parse(trimmed);
}
function questionProjection(events: AgentEvent[], pending?: Set<string>): SessionObservation["questions"] {
  const resolved = new Set(events.flatMap(event => event.type === "approval_resolved" ? [event.questionId] : []));
  return events.flatMap(event => event.type === "ask_user" && !resolved.has(event.questionId) && (!pending || pending.has(event.questionId))
    ? [{ id: event.questionId, text: event.question, options: event.options, multiSelect: event.multiSelect, requiresSource: !!event.fields?.length }]
    : []);
}
function contextText(messages: Array<{ role: string; content: unknown }>, events: AgentEvent[]): string {
  const text = messages.slice(-8).map(message => `${message.role}: ${typeof message.content === "string" ? message.content.slice(-3500) : "[非文本内容请到原会话查看]"}`).join("\n");
  const important = events.slice(-30).flatMap<{ type: string; text: string; isError?: boolean }>(event => {
    if (event.type === "error") return [{ type: event.type, text: event.message.slice(-2000) }];
    if (event.type === "done") return [{ type: event.type, text: event.finalText.slice(-3500) }];
    if (event.type === "turn_aborted") return [{ type: event.type, text: "执行被中断" }];
    if (event.type === "tool_call") return [{ type: event.type, text: event.toolCall.name }];
    if (event.type === "tool_result") return [{ type: event.type, text: String(event.result.content).slice(-1200), isError: event.result.isError }];
    return [];
  }).slice(-12);
  return `${text}\n最近执行事件：${JSON.stringify(important).slice(-12000)}`.slice(-22000);
}
function terminal(events: AgentEvent[]): SessionObservation["terminal"] {
  const last = events.filter(event => ["done", "error", "turn_aborted"].includes(event.type)).at(-1);
  return last?.type === "done" ? "done" : last?.type === "error" ? "error" : last?.type === "turn_aborted" ? "interrupted" : undefined;
}

export class ServerSupervisionRuntime implements SupervisionRuntime {
  private readonly collaboration = new ServerCollaborationRuntime();
  constructor(private readonly repository: SQLiteSupervisionRepository) {}

  async observe(target: MonitoredSession): Promise<SessionObservation> {
    if (isNativeSessionId(target.id)) {
      const service = getNativeRuntimeService();
      // Read only the current projection tail. Never hydrate a complete rollout.
      const head = await service.snapshot(target.id, Number.MAX_SAFE_INTEGER);
      const [detail, tail] = await Promise.all([
        service.get(target.id, { limit: 8, view: "core" }),
        service.snapshot(target.id, Math.max(0, head.snapshotRevision - 100)),
      ]);
      const events = [...tail.events.map(entry => entry.event), ...detail.events];
      const questions = [...new Map(questionProjection(events).map(question => [question.id, question])).values()];
      return {
        session: { id: detail.id, agentType: detail.agentType, title: detail.title, cwd: detail.cwd, projectId: detail.projectId, status: detail.status, updated: detail.updated, canResume: detail.canResume, readOnly: detail.readOnly, occupancy: detail.occupancy },
        revision: `${head.runId ?? "native"}:${head.snapshotRevision}:${detail.updated}:${detail.status}`,
        runId: head.runId ?? undefined, manuallyStopped: head.manuallyStopped === true,
        questions, context: contextText(detail.messages, events), terminal: terminal(tail.events.map(entry => entry.event)) ?? (detail.status === "failed" ? "error" : undefined),
        hasProgress: tail.events.some(entry => ["text_chunk", "tool_call", "tool_result", "reasoning_summary_delta", "runtime_progress"].includes(entry.event.type)),
        autoControlAvailable: typeof head.manuallyStopped === "boolean",
      };
    }
    const stored = await agentHost.getSessionStore().get(target.id);
    if (!stored) throw new Error("会话已删除或不可访问");
    const running = agentHost.isSessionRunning(target.id);
    const recoverable = agentHost.getRecoverableRun(stored);
    const events = running ? agentHost.recentSessionEvents(target.id) : stored.events.slice(-100);
    const revision = `${stored.updated}:${agentHost.getLatestEventId(target.id)}:${running}:${events.length}`;
    return {
      session: { ...target, title: stored.title, status: running ? "running" : recoverable || stored.status === "failed" ? "failed" : stored.status === "completed" ? "completed" : "idle", updated: stored.updated, canResume: true },
      revision, runId: recoverable?.runId, manuallyStopped: agentHost.isManuallyStopped(stored) || stored.status === "aborted",
      questions: questionProjection(events, agentHost.pendingQuestionIds(target.id)), context: contextText(stored.messages, events), terminal: terminal(events) ?? (recoverable && !running ? "interrupted" : undefined),
      hasProgress: events.some(event => ["text_chunk", "tool_call", "tool_result", "reasoning_summary_delta", "runtime_progress"].includes(event.type)),
    };
  }
  private async reason(state: SupervisionState, member: CollaborationMember, kind: string, prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const key = JSON.stringify([kind, member.id, member.agentType, state.group.cwd, member.model ?? null, member.profileId ?? null]);
    let sessionId = state.sessions[key];
    if (!sessionId) {
      sessionId = await this.collaboration.createSession(state.group, member, state.group.cwd);
      const current = this.repository.get(state.groupId);
      if (!current || current.generation !== state.generation || signal.aborted) throw new Error("监管配置已改变");
      current.sessions[key] = sessionId;
      state.sessions[key] = sessionId;
      if (!this.repository.save(current, state.generation)) throw new Error("监管配置已改变");
    }
    if (isNativeSessionId(sessionId)) await getNativeRuntimeService().setPermissionMode(sessionId, "request-approval");
    else await agentHost.setSessionPermissionMode(sessionId, "request-approval");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    // A stalled diagnostic must not occupy the supervisor indefinitely.
    const timer = setTimeout(abort, 120_000);
    try {
      const result = await this.collaboration.execute({ group: state.group, member, sessionId, prompt, signal: controller.signal }, progress => {
        // Diagnostic agents must return candidate JSON. Runtime approval requests
        // are surfaced instead of leaving an invisible background turn blocked.
        if (progress.question) controller.abort();
      });
      return result.text;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  }
  async evaluate(state: SupervisionState, observation: SessionObservation, signal: AbortSignal): Promise<SupervisionDecision> {
    const member = state.group.members.find(member => member.id === state.group.monitoring?.supervisorId);
    if (!member) throw new Error("监工成员不存在");
    return decisionSchema.parse(jsonObject(await this.reason(state, member, "supervisor", supervisionPrompt(state, observation), signal)));
  }
  async continue(target: MonitoredSession, text: string, actionId: string): Promise<InterventionReceipt> {
    const current = await this.observe(target);
    if (current.autoControlAvailable === false || current.manuallyStopped || current.questions.length || current.session.status === "running" || !current.session.canResume || current.session.readOnly || current.session.occupancy === "owned-externally") throw new Error("会话状态或共享后端能力已变化，未发送监工指令");
    const prompt = `监工介入（记录 ${actionId}）：先核对已有成果及当前运行状态；仅在原任务授权范围内继续，尊重用户已有约束，遇到业务选择仍询问用户。\n${text}`;
    if (isNativeSessionId(target.id)) {
      const result = await getNativeRuntimeService().enqueueMessage(target.id, { sourceMessageId: `supervision:${actionId}`, content: prompt }, "web");
      return { id: actionId, accepted: true, runId: result.started?.runId };
    }
    const admission = agentHost.startRun(prompt, target.id);
    void admission.completion.catch(error => console.error("Supervised Customer Agent run:", error));
    return { id: actionId, accepted: true, runId: admission.runId };
  }
  async handoff(state: SupervisionState, source: MonitoredSession, target: MonitoredSession, text: string, actionId: string, signal: AbortSignal): Promise<InterventionReceipt> {
    const owner = state.group.members.find(member => member.id === state.group.ownerId)!;
    const observations = await Promise.all([this.observe(source), this.observe(target)]);
    const output = await this.reason(state, owner, "handoff-owner", `你是群主 ${owner.name}，职责：${owner.role}。监工发现原有交接链断档。请核对现有任务关系，整理已有上下文、成果路径、验收条件与下一步，确保接收方可据此衔接。只输出 JSON，不调用工具或自行发送；禁止扩大任务范围。没有明确交接依据时拒绝并说明原因。\n来源与目标：${JSON.stringify(observations)}\n监工证据：${text}\n输出 {"approved":true,"message":"完整交接上下文及已有成果引用"} 或 {"approved":false,"message":"缺少依据或需要的业务决策"}`, signal);
    const result = z.object({ approved: z.boolean(), message: z.string().min(1).max(20000) }).parse(jsonObject(output));
    if (!result.approved) throw new Error(`群主需先核对：${result.message}`);
    if (signal.aborted) throw new Error("监工已暂停");
    const current = this.repository.get(state.groupId);
    if (!current || current.paused || current.generation !== state.generation) throw new Error("监管已暂停或配置已改变");
    return this.continue(target, `群主 ${owner.name} 衔接来自「${source.title}」的交付：\n${result.message}\n请先确认收到并核对已有成果，再推进既定下一步。`, actionId);
  }
  async answer(target: MonitoredSession, questionId: string, answer: string, indices?: number[]): Promise<boolean> {
    return this.collaboration.answer(target.id, questionId, answer, indices);
  }
  async notify(group: CollaborationGroup, incident: SupervisionIncident): Promise<void> {
    const { getWebPushService } = await import("../web-push-service.mjs");
    getWebPushService().notifySession({
      notificationId: `supervision:${incident.id}:${incident.status}`,
      sessionId: incident.sessionId,
      kind: incident.status === "waiting" ? "approval" : "completion",
      title: `${group.name} · ${incident.status === "waiting" ? "需要你决策" : incident.kind === "handoff" ? "交接已衔接" : incident.kind === "delivery" ? "交付已确认" : "会话已恢复"}`,
      body: incident.message.slice(0, 160), url: `/app/?view=session-dashboard&groupId=${encodeURIComponent(group.id)}`,
    });
  }
}
