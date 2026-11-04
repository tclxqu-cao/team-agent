import { describe, expect, it, vi } from "vitest";
import { groupFixture } from "../../domain/collaboration/__tests__/fixtures.js";
import type { InterventionReceipt, MonitoredSession, SessionObservation, SupervisionMessage, SupervisionState } from "../../domain/supervision/types.js";
import type { SupervisionRepository, SupervisionRuntime } from "./ports.js";
import { SupervisionService } from "./SupervisionService.js";

class MemoryRepository implements SupervisionRepository {
  private states = new Map<string, SupervisionState>();
  private leases = new Map<string, { owner: string; until: number }>();
  readonly messages = new Map<string, SupervisionMessage>();
  get(id: string) { return structuredClone(this.states.get(id) ?? null); }
  initialize(state: SupervisionState) { if (!this.states.has(state.groupId)) this.save(state); return this.get(state.groupId)!; }
  save(state: SupervisionState, generation?: number, messages: SupervisionMessage[] = []) {
    if (generation !== undefined && this.states.get(state.groupId)?.generation !== generation) return false;
    this.states.set(state.groupId, structuredClone(state)); messages.forEach(message => this.appendMessage(message)); return true;
  }
  appendMessage(message: SupervisionMessage) { this.messages.set(message.id, structuredClone(message)); }
  listMessages(groupId: string) { return { messages: [...this.messages.values()].filter(message => message.groupId === groupId), nextBefore: null, latestSequence: this.messages.size }; }
  claim(id: string, owner: string, now: number, ttl: number) { return this.lease(`group:${id}`, owner, now, ttl); }
  claimTarget(id: string, owner: string, now: number, ttl: number) { return this.lease(`target:${id}`, owner, now, ttl); }
  private lease(id: string, owner: string, now: number, ttl: number) {
    const current = this.leases.get(id);
    if (current && current.owner !== owner && current.until >= now) return false;
    this.leases.set(id, { owner, until: now + ttl }); return true;
  }
}

const target: MonitoredSession = { id: "codex:original", agentType: "codex", title: "赔付日报", cwd: "/project" };
function setup() {
  let now = Date.parse("2026-11-02T14:00:00Z"), sequence = 0;
  const group = groupFixture(); group.monitoring = { supervisorId: "a", targets: [target] };
  const repo = new MemoryRepository();
  const source: SessionObservation = { session: { ...target, status: "failed", updated: "2026-11-02", canResume: true }, revision: "original:0", runId: "original", manuallyStopped: false, questions: [], context: "原任务意外中断", terminal: "error" };
  const deliveries = new Map<string, InterventionReceipt>();
  const runtime = {
    observe: vi.fn<SupervisionRuntime["observe"]>(async () => structuredClone(source)),
    evaluate: vi.fn<SupervisionRuntime["evaluate"]>().mockResolvedValue({ action: "continue", reason: "任务意外中断", message: "核对成果后继续" }),
    continue: vi.fn<SupervisionRuntime["continue"]>(async (_target, _text, actionId) => {
      const receipt: InterventionReceipt = { id: actionId, accepted: true, messageId: `message:${actionId}`, status: "queued" };
      deliveries.set(actionId, receipt); return structuredClone(receipt);
    }),
    interventionStatus: vi.fn<NonNullable<SupervisionRuntime["interventionStatus"]>>(async (_target, actionId) => structuredClone(deliveries.get(actionId) ?? null)),
    handoff: vi.fn<SupervisionRuntime["handoff"]>(),
    answer: vi.fn<SupervisionRuntime["answer"]>().mockResolvedValue(true),
    notify: vi.fn<SupervisionRuntime["notify"]>().mockResolvedValue(),
  };
  const errors: unknown[] = [];
  const service = new SupervisionService(repo, () => [group], runtime, () => now, () => `id-${++sequence}`, error => errors.push(error));
  const check = async (advance = 10_001, instance = service) => {
    now += advance; await instance.tick();
    for (let count = 0; count < 100 && instance.runningChecks; count++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(instance.runningChecks).toBe(0);
  };
  const incident = () => repo.get(group.id)!.incidents[0];
  const delivery = (update: Partial<InterventionReceipt>) => { const item = incident(); deliveries.set(item.actionId!, { ...deliveries.get(item.actionId!)!, ...update }); };
  return { repo, runtime, source, service, check, group, incident, delivery, errors, now: () => now };
}

describe("supervision queued intervention decisions", () => {
  it("keeps the original queued instruction quiet beyond 60 seconds and ignores duplicate continue replies", async () => {
    const s = setup(); await s.check();
    expect(s.incident().status).toBe("queued");
    for (let count = 0; count < 3; count++) {
      s.source.revision = `external:${count}`;
      s.source.session.status = "running"; s.source.terminal = undefined; s.source.hasProgress = true;
      await s.check(75_000);
      await s.service.answer("g", s.incident().id, "继续");
      expect(s.incident().status).toBe("queued");
    }
    expect(s.runtime.continue).toHaveBeenCalledTimes(1);
    expect(s.runtime.evaluate).toHaveBeenCalledTimes(1);
    expect(s.runtime.notify).not.toHaveBeenCalled();
    expect(s.errors).toEqual([]);
  });

  it("answers one business decision once, waits through queued and running, then verifies its own progress", async () => {
    const s = setup(); s.runtime.evaluate.mockResolvedValue({ action: "decision", reason: "是否继续原任务" });
    await s.check(); const id = s.incident().id;
    await Promise.all([s.service.answer("g", id, "继续"), s.service.answer("g", id, "继续")]);
    expect(s.incident().status).toBe("queued");
    s.runtime.notify.mockClear(); await s.check(120_000);
    s.delivery({ status: "running", runId: "resumed" });
    s.source.session.status = "running"; s.source.runId = "resumed"; s.source.revision = "resumed:1"; s.source.terminal = undefined;
    await s.check(); await s.check(120_000);
    expect(s.incident().status).toBe("verifying");
    expect(s.runtime.notify).not.toHaveBeenCalled();
    s.source.revision = "resumed:2"; s.source.hasProgress = true; await s.check();
    expect(s.incident().status).toBe("resolved");
    expect(s.runtime.continue).toHaveBeenCalledTimes(1);
    expect([...s.repo.messages.values()].filter(message => message.title === "收到你的决策")).toHaveLength(1);
  });

  it("claims a reply before observation so another host cannot admit the same decision", async () => {
    const s = setup(); s.runtime.evaluate.mockResolvedValue({ action: "decision", reason: "是否继续原任务" }); await s.check();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.runtime.observe.mockImplementationOnce(async () => { await gate; return structuredClone(s.source); });
    const first = s.service.answer("g", s.incident().id, "继续");
    const other = new SupervisionService(s.repo, () => [s.group], s.runtime, s.now, () => "other");
    expect((await other.answer("g", s.incident().id, "继续")).incidents[0].status).toBe("executing");
    await s.service.tick(); expect(s.service.runningChecks).toBe(0);
    release(); await first;
    expect(s.runtime.continue).toHaveBeenCalledTimes(1);
    expect(s.incident().status).toBe("queued");
  });

  it("repairs a legacy waiting receipt after restart without replaying any instruction", async () => {
    const s = setup(); await s.check();
    const state = s.repo.get("g")!; const old = state.incidents[0];
    old.status = "waiting"; old.kind = "blocker"; old.receipt = { id: old.actionId!, accepted: true };
    old.message = "介入已记录，但尚未确认新进度"; s.repo.save(state);
    const restarted = new SupervisionService(s.repo, () => [s.group], s.runtime, s.now, () => "restarted");
    await s.check(31_000, restarted);
    expect(s.incident()).toMatchObject({ status: "queued", receipt: { messageId: `message:${old.actionId}` } });
    await restarted.answer("g", old.id, "继续"); await s.check(120_000, restarted);
    expect(s.runtime.continue).toHaveBeenCalledTimes(1);
    expect(s.runtime.notify).not.toHaveBeenCalled();
  });

  it("reconciles a repeated reply to a legacy waiting receipt instead of creating a new action", async () => {
    const s = setup(); await s.check();
    const state = s.repo.get("g")!; const old = state.incidents[0];
    old.status = "waiting"; old.receipt = { id: old.actionId!, accepted: true }; s.repo.save(state);
    await s.service.answer("g", old.id, "继续");
    expect(s.incident().status).toBe("queued"); expect(s.incident().actionId).toBe(old.actionId);
    expect(s.runtime.continue).toHaveBeenCalledTimes(1);
  });

  it("does not turn a temporary queue status lookup failure into another user decision", async () => {
    const s = setup(); await s.check(); s.runtime.interventionStatus.mockRejectedValue(new Error("暂时离线"));
    await s.check(120_000); await s.service.answer("g", s.incident().id, "继续");
    expect(s.incident().status).toBe("queued");
    expect(s.runtime.continue).toHaveBeenCalledTimes(1); expect(s.runtime.notify).not.toHaveBeenCalled();
    expect(s.errors).toHaveLength(1);
  });

  it("does not replay an uncertain send when a receipt was lost", async () => {
    const s = setup(); s.runtime.continue.mockRejectedValue(new Error("发送超时，结果未知"));
    await s.check(); const id = s.incident().id; await s.check(120_000);
    await s.service.answer("g", id, "继续");
    const incident = s.repo.get("g")!.incidents.find(incident => incident.id === id)!;
    expect(incident.status).toBe("verifying");
    expect(incident.message).toContain("投递结果尚未确认");
    expect(s.runtime.continue).toHaveBeenCalledTimes(1); expect(s.runtime.notify).not.toHaveBeenCalled();
  });

  it("reconciles an interrupted original-question answer after restart using the source question ID", async () => {
    const s = setup(); s.source.questions = [{ id: "source-question", text: "选择交付方式" }];
    await s.check();
    const state = s.repo.get("g")!; state.incidents[0].status = "executing"; s.repo.save(state);
    const restarted = new SupervisionService(s.repo, () => [s.group], s.runtime, s.now, () => "restarted");
    await s.check(31_000, restarted);
    expect(s.incident()).toMatchObject({ status: "waiting", question: { id: "source-question" } });
    s.source.questions = []; await s.check(10_001, restarted);
    expect(s.incident().status).toBe("dismissed");
    expect(s.runtime.continue).not.toHaveBeenCalled();
  });

  it("settles a queued instruction from its persisted completion even when its broker events have expired", async () => {
    const s = setup(); await s.check();
    s.delivery({ status: "completed" }); await s.check(120_000);
    expect(s.incident().status).toBe("resolved");
    expect(s.runtime.continue).toHaveBeenCalledTimes(1);
  });

  it("surfaces an actual queue failure once and permits a deliberate retry", async () => {
    const s = setup(); await s.check(); const oldAction = s.incident().actionId;
    s.delivery({ status: "failed", reason: "模型额度不足" }); await s.check(120_000); await s.check(120_000);
    expect(s.incident().status).toBe("waiting"); expect(s.incident().message).toContain("模型额度不足");
    expect(s.runtime.notify).toHaveBeenCalledTimes(1);
    await s.service.answer("g", s.incident().id, "已切换模型，继续");
    expect(s.runtime.continue).toHaveBeenCalledTimes(2); expect(s.incident().actionId).not.toBe(oldAction);
    expect(s.incident().status).toBe("queued");
  });

  it.each(["cancelled", "manual-stop"])("honors %s while a supervision instruction is pending", async outcome => {
    const s = setup(); await s.check();
    if (outcome === "cancelled") s.delivery({ status: "cancelled" });
    else s.source.manuallyStopped = true;
    await s.check(120_000);
    expect(s.incident().status).toBe("dismissed"); expect(s.runtime.continue).toHaveBeenCalledTimes(1);
    expect(s.runtime.notify).not.toHaveBeenCalled();
  });
});
