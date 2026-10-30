import { CollaborationError, type CollaborationGroup } from "../../domain/collaboration/types.js";
import type { MonitoredSession, SessionObservation, SupervisionIncident, SupervisionState } from "../../domain/supervision/types.js";
import type { SupervisionRepository, SupervisionRuntime } from "./ports.js";

const LEASE_MS = 30_000;
const CHECK_MS = 10_000;
const VERIFY_MS = 60_000;
const MAX_RECOVERIES = 2;

export function monitoringConfiguration(group: CollaborationGroup): string {
  const member = group.members.find(m => m.id === group.monitoring?.supervisorId);
  const owner = group.members.find(m => m.id === group.ownerId);
  return JSON.stringify({ monitoring: group.monitoring, member, owner });
}

/** Background use cases. No viewers, database implementation or agent SDK required. */
export class SupervisionService {
  private readonly owner: string;
  private readonly jobs = new Map<string, { controller: AbortController; generation: number }>();
  private readonly nextCheck = new Map<string, number>();
  constructor(
    readonly repository: SupervisionRepository,
    private readonly groups: () => CollaborationGroup[],
    private readonly runtime: SupervisionRuntime,
    private readonly now = Date.now,
    private readonly id: () => string = () => crypto.randomUUID(),
    private readonly reportError: (error: unknown) => void = () => {},
  ) { this.owner = id(); }

  private group(groupId: string): CollaborationGroup {
    const group = this.groups().find(group => group.id === groupId);
    if (!group) throw new CollaborationError("协作群不存在", "NOT_FOUND");
    return group;
  }
  private initial(group: CollaborationGroup, generation = 0): SupervisionState {
    return { groupId: group.id, group: structuredClone(group), paused: false, generation, updatedAt: this.at(), cursors: {}, incidents: [], sessions: {} };
  }
  private at(): string { return new Date(this.now()).toISOString(); }
  apply(groupId: string): SupervisionState {
    const group = this.group(groupId);
    this.jobs.get(groupId)?.controller.abort();
    const old = this.repository.initialize(this.initial(group));
    const state = this.initial(group, (old?.generation ?? 0) + 1);
    state.sessions = old?.sessions ?? {};
    state.incidents = (old?.incidents ?? []).map(incident =>
      ["resolved", "dismissed"].includes(incident.status) ? incident : { ...incident, status: "dismissed", updatedAt: this.at(), message: `${incident.message}\n监管配置已重新应用，请核对原会话。` });
    if (!this.repository.save(state, old.generation)) throw new CollaborationError("监管配置已改变，请刷新");
    this.nextCheck.delete(groupId);
    return state;
  }
  pause(groupId: string, paused: boolean): SupervisionState {
    this.group(groupId);
    const state = this.repository.initialize(this.initial(this.group(groupId)));
    const generation = state.generation;
    state.paused = paused;
    state.generation++;
    state.updatedAt = this.at();
    if (!this.repository.save(state, generation)) throw new CollaborationError("监管配置已改变，请刷新");
    this.jobs.get(groupId)?.controller.abort();
    this.nextCheck.delete(groupId);
    return state;
  }
  private persist(state: SupervisionState): void {
    const current = this.repository.get(state.groupId);
    if (current && current.generation !== state.generation) throw new Error("监管配置已改变");
    state.updatedAt = this.at();
    // Unresolved decisions are retained; only settled audit history is bounded.
    const settled = state.incidents.filter(i => ["resolved", "dismissed"].includes(i.status)).slice(-200);
    state.incidents = [...settled, ...state.incidents.filter(i => !["resolved", "dismissed"].includes(i.status))];
    if (!this.repository.save(state, state.generation)) throw new Error("监管配置已改变");
  }
  private assertActive(state: SupervisionState, signal: AbortSignal): void {
    const current = this.repository.get(state.groupId);
    if (signal.aborted || !current || current.paused || current.generation !== state.generation || !this.groups().some(g => g.id === state.groupId))
      throw new Error("监管已暂停或配置已改变");
    if (!this.repository.claim(state.groupId, this.owner, this.now(), LEASE_MS)) throw new Error("监管租约已转移");
  }
  async tick(): Promise<void> {
    const groups = this.groups();
    for (const [groupId, job] of this.jobs) {
      const current = this.repository.get(groupId);
      if (!current || current.paused || current.generation !== job.generation || !groups.some(g => g.id === groupId) || !this.repository.claim(groupId, this.owner, this.now(), LEASE_MS)) job.controller.abort();
    }
    for (const group of groups) {
      let state = this.repository.get(group.id);
      if (!state && group.monitoring?.supervisorId && group.monitoring.targets.length) {
        state = this.repository.initialize(this.initial(group));
      }
      if (state && this.repository.claim(group.id, this.owner, this.now(), LEASE_MS))
        for (const incident of state.incidents.filter(incident => incident.targetSessionId && ["executing", "verifying"].includes(incident.status)))
          this.repository.claimTarget(incident.targetSessionId!, `${this.owner}:${state.groupId}`, this.now(), LEASE_MS);
      if (!state || state.paused || !state.group.monitoring?.supervisorId || !state.group.monitoring.targets.length || this.jobs.has(group.id) || (this.nextCheck.get(group.id) ?? 0) > this.now()) continue;
      if (!this.repository.claim(group.id, this.owner, this.now(), LEASE_MS)) continue;
      const controller = new AbortController();
      this.jobs.set(group.id, { controller, generation: state.generation });
      this.nextCheck.set(group.id, this.now() + CHECK_MS);
      void this.check(state, controller.signal).catch(error => {
        if (!controller.signal.aborted) this.reportError(error);
      }).finally(() => { if (this.jobs.get(group.id)?.controller === controller) this.jobs.delete(group.id); });
    }
  }
  /** Tests and graceful shutdown may await currently admitted checks. */
  get runningChecks(): number { return this.jobs.size; }

  private incident(state: SupervisionState, target: MonitoredSession, fingerprint: string, kind: SupervisionIncident["kind"], message: string): SupervisionIncident {
    let incident = state.incidents.find(i => i.fingerprint === fingerprint);
    if (!incident) {
      incident = { id: this.id(), groupId: state.groupId, sessionId: target.id, sessionTitle: target.title, fingerprint, kind, status: "evaluating", message, createdAt: this.at(), updatedAt: this.at(), attempts: 0 };
      state.incidents.push(incident);
    }
    return incident;
  }
  private async notify(state: SupervisionState, incident: SupervisionIncident): Promise<void> {
    if (incident.notifiedAt) return;
    await this.runtime.notify(state.group, incident);
    incident.notifiedAt = this.at();
    this.persist(state);
  }
  private async check(state: SupervisionState, signal: AbortSignal): Promise<void> {
    for (const target of state.group.monitoring!.targets) {
      this.assertActive(state, signal);
      try {
        const observation = await this.runtime.observe(target);
        this.assertActive(state, signal);
        const inspection = state.incidents.find(incident => incident.fingerprint === `inspect:${target.id}`);
        if (inspection?.status === "waiting" && state.cursors[target.id]?.revision === observation.revision) continue;
        if (inspection) { inspection.status = "resolved"; inspection.kind = "observation"; }
        await this.process(state, target, observation, signal);
      } catch (error) {
        this.assertActive(state, signal);
        const incident = this.incident(state, target, `inspect:${target.id}`, "blocker", `无法核对原会话：${error instanceof Error ? error.message : String(error)}`);
        incident.attempts++;
        incident.kind = "blocker";
        incident.status = incident.attempts >= 3 ? "waiting" : "evaluating";
        incident.message = `无法核对或诊断原会话：${error instanceof Error ? error.message : String(error)}`;
        this.persist(state);
        if (incident.status === "waiting") await this.notify(state, incident);
      }
    }
    // Failed notification delivery is retried with the same stable notification ID.
    for (const incident of state.incidents.filter(i => !i.notifiedAt && (i.status === "waiting" || (i.status === "resolved" && ["recovery", "handoff", "delivery"].includes(i.kind))))) {
      try { await this.notify(state, incident); } catch (error) { this.reportError(error); }
    }
  }
  private async process(state: SupervisionState, target: MonitoredSession, observation: SessionObservation, signal: AbortSignal): Promise<void> {
    const cursor = state.cursors[target.id];
    if (cursor && observation.revision !== cursor.revision && observation.session.status === "running" && observation.hasProgress && !observation.manuallyStopped && !observation.questions.length) {
      for (const incident of state.incidents.filter(incident => (incident.sessionId === target.id || incident.targetSessionId === target.id) && incident.status === "waiting" && incident.kind !== "question")) {
        incident.status = "dismissed"; incident.kind = "observation";
        incident.message = `${incident.message}\n已在原会话出现新进度，此提醒已结束。`; incident.updatedAt = this.at();
      }
    }
    for (const incident of state.incidents.filter(i => i.sessionId === target.id && i.kind === "question" && i.status === "waiting")) {
      if (!observation.questions.some(q => q.id === incident.question?.id)) { incident.status = "dismissed"; incident.updatedAt = this.at(); }
    }
    for (const question of observation.questions) {
      const incident = this.incident(state, target, `question:${target.id}:${question.id}`, "question", question.text);
      if (!["resolved", "dismissed"].includes(incident.status)) { incident.question = question; incident.status = "waiting"; }
    }
    state.cursors[target.id] = { revision: observation.revision, status: observation.session.status, terminal: observation.terminal, recoveryAttempts: cursor?.recoveryAttempts ?? 0, lastRecoveryAt: cursor?.lastRecoveryAt, lastEvaluatedAt: cursor?.lastEvaluatedAt };
    const current = state.cursors[target.id];
    // Reconcile journaled actions first, including after a process restart.
    for (const incident of state.incidents.filter(i => i.targetSessionId === target.id && ["executing", "verifying"].includes(i.status))) {
      const progressed = observation.revision !== incident.beforeRevision && observation.terminal !== "error" && (observation.hasProgress || observation.terminal === "done" || observation.questions.length > 0);
      const failedNewRun = observation.terminal === "error" && observation.session.status !== "running" && !!observation.runId && observation.runId !== incident.beforeRunId;
      if (!observation.manuallyStopped && progressed) {
        incident.status = "resolved";
        incident.message = `${incident.message}\n已核对下游接收并出现新进度。`;
        incident.updatedAt = this.at();
      } else if (!observation.manuallyStopped && failedNewRun) {
        incident.status = "dismissed";
        incident.message = `${incident.message}\n本次介入后的执行明确失败，将在恢复次数上限内重新诊断。`;
        incident.updatedAt = this.at();
      } else if (observation.manuallyStopped) {
        incident.status = "dismissed"; incident.kind = "observation";
        incident.message = "会话被主动停止，监工已保留停止状态。"; incident.updatedAt = this.at();
      } else if (this.now() - Date.parse(incident.updatedAt) > VERIFY_MS) {
        incident.status = "waiting";
        incident.kind = "blocker";
        incident.message = "介入已记录，但尚未确认新进度。请核对原会话，避免重复发送。";
        incident.notifiedAt = undefined;
      }
    }
    this.persist(state);
    if (observation.manuallyStopped || observation.questions.length || observation.session.status === "running") return;
    if (state.incidents.some(i => (i.sessionId === target.id || i.targetSessionId === target.id) && ["executing", "verifying", "waiting"].includes(i.status))) return;
    const abnormal = observation.session.status === "failed" || observation.terminal === "error" || observation.terminal === "interrupted";
    const changed = !cursor || cursor.revision !== observation.revision;
    const stoppedAfterRunning = cursor?.status === "running";
    const evaluating = state.incidents.some(incident => incident.fingerprint === `change:${target.id}:${observation.revision}` && incident.status === "evaluating");
    if ((!changed && !evaluating) || (!abnormal && !stoppedAfterRunning && !(cursor && observation.terminal === "done"))) return;
    const incident = this.incident(state, target, `change:${target.id}:${observation.revision}`, "recovery", "监工正在核对会话状态");
    if (incident.status !== "evaluating") return;
    if (observation.autoControlAvailable === false) {
      incident.kind = "blocker"; incident.status = "waiting";
      incident.message = "当前共享后端尚未提供主动停止状态。需要更新共享后端后，监工才能区分主动停止与意外中断；可先进入原会话处理。";
      this.persist(state); return;
    }
    current.lastEvaluatedAt = this.now();
    this.persist(state);
    const decision = await this.runtime.evaluate(state, observation, signal);
    this.assertActive(state, signal);
    incident.message = decision.reason;
    incident.updatedAt = this.at();
    if (decision.action === "observe" || decision.action === "complete") {
      incident.status = "resolved";
      incident.kind = decision.action === "complete" ? "delivery" : "observation";
      if (decision.action === "observe") incident.notifiedAt = this.at();
      else current.recoveryAttempts = 0;
      this.persist(state);
      return;
    }
    if (decision.action === "decision") {
      incident.kind = "blocker"; incident.status = "waiting"; incident.options = decision.options; incident.recommendation = decision.recommendation;
      this.persist(state);
      return;
    }
    const destination = decision.action === "handoff" ? state.group.monitoring!.targets.find(t => t.id === decision.targetSessionId) : target;
    if (!destination || (decision.action === "handoff" && destination.id === target.id)) throw new Error("交接目标必须是本群另一个关联会话");
    if (current.recoveryAttempts >= MAX_RECOVERIES) {
      incident.kind = "blocker"; incident.status = "waiting"; incident.message = `自动恢复已达 ${MAX_RECOVERIES} 次上限，需要核对：${decision.reason}`;
      this.persist(state); return;
    }
    const latest = await this.runtime.observe(destination);
    this.assertActive(state, signal);
    if (latest.manuallyStopped || latest.questions.length || latest.session.status === "running") { incident.status = "dismissed"; this.persist(state); return; }
    if (!latest.session.canResume || latest.session.readOnly || latest.session.occupancy === "owned-externally") throw new Error("当前会话不可继续，请在原会话处理占用或访问限制");
    if (!this.repository.claimTarget(destination.id, `${this.owner}:${state.groupId}`, this.now(), LEASE_MS)) {
      incident.status = "dismissed"; incident.message = "其他群的监工正在处理此会话"; this.persist(state); return;
    }
    incident.kind = decision.action === "handoff" ? "handoff" : "recovery";
    incident.status = "executing"; incident.actionId = this.id(); incident.targetSessionId = destination.id;
    incident.beforeRevision = latest.revision; incident.beforeRunId = latest.runId; incident.attempts++;
    current.recoveryAttempts++; current.lastRecoveryAt = this.now();
    this.persist(state); // Write intent before runtime admission. Never replay an uncertain send.
    incident.receipt = decision.action === "handoff"
      ? await this.runtime.handoff(state, target, destination, decision.message, incident.actionId, signal)
      : await this.runtime.continue(destination, decision.message, incident.actionId);
    this.assertActive(state, signal);
    incident.status = incident.receipt.accepted ? "verifying" : "waiting";
    incident.updatedAt = this.at();
    this.persist(state);
  }
  async answer(groupId: string, incidentId: string, answer: string, indices?: number[]): Promise<SupervisionState> {
    this.group(groupId);
    const state = this.repository.get(groupId);
    const incident = state?.incidents.find(i => i.id === incidentId && i.status === "waiting");
    if (!state || !incident || !answer.trim()) throw new CollaborationError("待处理决策不存在或已处理");
    const target = state.group.monitoring?.targets.find(t => t.id === incident.sessionId);
    if (!target) throw new CollaborationError("原会话不再关联");
    if (incident.question?.requiresSource) throw new CollaborationError("请在原会话填写此问题");
    const generation = state.generation++;
    if (!this.repository.save(state, generation)) throw new CollaborationError("监管配置已改变，请刷新");
    this.jobs.get(groupId)?.controller.abort();
    const latest = await this.runtime.observe(target);
    if (incident.question) {
      const question = latest.questions.find(question => question.id === incident.question!.id);
      if (!question) throw new CollaborationError("原问题已失效，请刷新原会话");
      if (indices && (!question?.options || indices.some(index => !Number.isInteger(index) || index < 0 || index >= question.options!.length) || new Set(indices).size !== indices.length || !question.multiSelect && indices.length > 1))
        throw new CollaborationError("所选答案与原问题不匹配");
      if (!latest.questions.some(q => q.id === incident.question!.id) || !(await this.runtime.answer(target, incident.question.id, answer, indices)))
        throw new CollaborationError("原问题已失效，请刷新原会话");
    } else {
      if (latest.manuallyStopped || latest.session.status === "running" || latest.questions.length || !latest.session.canResume)
        throw new CollaborationError("原会话状态已变化，请进入原会话处理");
      if (!this.repository.claimTarget(target.id, `answer:${incident.id}`, this.now(), LEASE_MS)) throw new CollaborationError("另一位监工正在处理原会话");
      incident.status = "executing"; incident.actionId = this.id(); incident.targetSessionId = target.id; incident.beforeRevision = latest.revision; incident.beforeRunId = latest.runId;
      this.persist(state);
      incident.receipt = await this.runtime.continue(target, `用户对监工决策的答复：${answer}`, incident.actionId);
      incident.status = "verifying";
    }
    if (incident.question) incident.status = "resolved";
    incident.updatedAt = this.at();
    this.persist(state);
    this.nextCheck.delete(groupId);
    return state;
  }
}
