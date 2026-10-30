import { describe, expect, it, vi } from "vitest";
import { groupFixture } from "../../domain/collaboration/__tests__/fixtures.js";
import type { CollaborationGroup } from "../../domain/collaboration/types.js";
import type { MonitoredSession, SessionObservation, SupervisionState } from "../../domain/supervision/types.js";
import { SupervisionService } from "./SupervisionService.js";
import type { SupervisionRepository, SupervisionRuntime } from "./ports.js";
import { supervisionPrompt } from "./prompts.js";

class MemoryRepository implements SupervisionRepository {
  states = new Map<string, SupervisionState>();
  leases = new Map<string, { owner: string; until: number }>();
  get(id: string) { return structuredClone(this.states.get(id) ?? null); }
  initialize(state: SupervisionState) { if (!this.states.has(state.groupId)) this.save(state); return this.get(state.groupId)!; }
  save(state: SupervisionState, expectedGeneration?: number) {
    if (expectedGeneration !== undefined && this.states.get(state.groupId)?.generation !== expectedGeneration) return false;
    this.states.set(state.groupId, structuredClone(state)); return true;
  }
  claim(id: string, owner: string, now: number, ttl: number) { return this.lease(`group:${id}`, owner, now, ttl); }
  claimTarget(id: string, owner: string, now: number, ttl: number) { return this.lease(`target:${id}`, owner, now, ttl); }
  private lease(id: string, owner: string, now: number, ttl: number) {
    const old = this.leases.get(id);
    if (old && old.owner !== owner && old.until >= now) return false;
    this.leases.set(id, { owner, until: now + ttl }); return true;
  }
}
const target: MonitoredSession = { id: "codex:original", agentType: "codex", title: "原始任务", cwd: "/project" };
function observation(update: Partial<SessionObservation> = {}): SessionObservation {
  return { session: { ...target, status: "failed", updated: "2026-10-28", canResume: true }, revision: "run1:2", runId: "run1", manuallyStopped: false, questions: [], context: "网络中断，尚未交付", terminal: "error", ...update };
}
function setup() {
  let now = Date.parse("2026-10-28T00:00:00Z"), sequence = 0;
  const group = groupFixture(); group.monitoring = { supervisorId: "a", targets: [target] };
  group.members[1].role = "重点关注接口交付；自动恢复临时失败，价格选择请我决策";
  const groups: CollaborationGroup[] = [group];
  const repo = new MemoryRepository();
  const observations = new Map([[target.id, observation()]]);
  const runtime = {
    observe: vi.fn(async (target: MonitoredSession) => structuredClone(observations.get(target.id)!)),
    evaluate: vi.fn<SupervisionRuntime["evaluate"]>().mockResolvedValue({ action: "continue", reason: "已确认网络中断", message: "先核对成果，继续原接口任务" }),
    continue: vi.fn<SupervisionRuntime["continue"]>().mockResolvedValue({ id: "receipt", accepted: true, runId: "run2" }),
    handoff: vi.fn<SupervisionRuntime["handoff"]>().mockResolvedValue({ id: "handoff-receipt", accepted: true, runId: "downstream" }),
    answer: vi.fn<SupervisionRuntime["answer"]>().mockResolvedValue(true),
    notify: vi.fn<SupervisionRuntime["notify"]>().mockResolvedValue(),
  };
  const errors: unknown[] = [];
  const service = new SupervisionService(repo, () => groups, runtime, () => now, () => `id-${++sequence}`, error => errors.push(error));
  const check = async (advance = 10001, instance = service) => {
    now += advance; await instance.tick();
    for (let i = 0; i < 100 && instance.runningChecks; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(instance.runningChecks).toBe(0);
  };
  return { group, groups, repo, runtime, observations, service, errors, check, setNow: (value: number) => { now = value; }, now: () => now };
}

describe("background group supervision", () => {
  it("leaves old groups and normal tool/build waits quiet regardless of time without text", async () => {
    const s = setup(); delete s.group.monitoring;
    await s.check(); expect(s.runtime.observe).not.toHaveBeenCalled();
    s.group.monitoring = { supervisorId: "a", targets: [target] };
    s.observations.set(target.id, observation({ session: { ...observation().session, status: "running" }, terminal: undefined, context: "工具正在构建" }));
    await s.check(); await s.check(20 * 60_000);
    expect(s.runtime.evaluate).not.toHaveBeenCalled(); expect(s.runtime.notify).not.toHaveBeenCalled();
  });
  it("never resumes a user-stopped session or a paused supervision scope", async () => {
    const s = setup(); s.observations.set(target.id, observation({ manuallyStopped: true }));
    await s.check(); expect(s.runtime.continue).not.toHaveBeenCalled();
    s.service.pause(s.group.id, true); s.runtime.observe.mockClear();
    await s.check(); expect(s.runtime.observe).not.toHaveBeenCalled();
  });
  it("requires stop-intent support from an older shared broker before automatic intervention", async () => {
    const s = setup(); s.observations.set(target.id, observation({ autoControlAvailable: false }));
    await s.check(); expect(s.runtime.evaluate).not.toHaveBeenCalled(); expect(s.runtime.continue).not.toHaveBeenCalled();
    expect(s.repo.get("g")?.incidents[0].message).toContain("更新共享后端");
  });
  it("honors a pause from another host while a supervisor is reasoning", async () => {
    const s = setup(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    s.runtime.evaluate.mockImplementation(async () => { await gate; return { action: "continue", reason: "暂时中断", message: "核对后继续" }; });
    await s.service.tick();
    for (let i = 0; i < 20 && !s.runtime.evaluate.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const other = new SupervisionService(s.repo, () => s.groups, s.runtime, s.now, () => "other-host");
    other.pause("g", true); await s.service.tick(); release();
    for (let i = 0; i < 20 && s.service.runningChecks; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(s.runtime.continue).not.toHaveBeenCalled(); expect(s.repo.get("g")?.paused).toBe(true); expect(s.repo.get("g")?.generation).toBe(1);
  });
  it("uses the selected supervisor policy and persists intent before admission, then requires actual new progress", async () => {
    const s = setup();
    s.runtime.continue.mockImplementation(async () => {
      expect(s.repo.get("g")?.incidents.find(i => i.kind === "recovery")?.status).toBe("executing");
      return { id: "receipt", accepted: true, runId: "run2" };
    });
    await s.check();
    expect(s.runtime.evaluate.mock.calls[0][0].group.monitoring?.supervisorId).toBe("a");
    expect(supervisionPrompt(s.repo.get("g")!, observation())).toContain("价格选择请我决策");
    expect(s.runtime.continue).toHaveBeenCalledTimes(1);
    expect(s.runtime.notify).not.toHaveBeenCalled();
    s.observations.set(target.id, observation({ revision: "run2:1", runId: "run2", terminal: undefined, session: { ...observation().session, status: "running" }, hasProgress: false }));
    await s.check(); expect(s.repo.get("g")?.incidents[0].status).toBe("verifying");
    s.observations.set(target.id, { ...s.observations.get(target.id)!, revision: "run2:5", hasProgress: true });
    await s.check();
    expect(s.repo.get("g")?.incidents[0].status).toBe("resolved");
    expect(s.runtime.notify).toHaveBeenCalledTimes(1);
    await s.check(); expect(s.runtime.notify).toHaveBeenCalledTimes(1);
  });
  it("reconciles a journaled send after restart without replaying it", async () => {
    const s = setup(); await s.check();
    const scope = s.repo.get("g")!; scope.incidents[0].status = "executing"; delete scope.incidents[0].receipt; s.repo.save(scope);
    s.observations.set(target.id, observation({ revision: "run2:8", runId: "run2", terminal: undefined, hasProgress: true, session: { ...observation().session, status: "running" } }));
    const restarted = new SupervisionService(s.repo, () => s.groups, s.runtime, s.now, () => "restarted");
    await s.check(31_000, restarted);
    expect(s.runtime.continue).toHaveBeenCalledTimes(1);
    expect(s.repo.get("g")?.incidents[0].status).toBe("resolved");
  });
  it("does not count immediately failed runs as recovery success and retries only up to the bound", async () => {
    const s = setup(); await s.check();
    s.observations.set(target.id, observation({ revision: "run2:2", runId: "run2" }));
    await s.check(); expect(s.repo.get("g")?.incidents[0].status).toBe("dismissed");
    expect(s.runtime.continue).toHaveBeenCalledTimes(2); expect(s.runtime.notify).not.toHaveBeenCalled();
    s.observations.set(target.id, observation({ revision: "run3:2", runId: "run3" })); await s.check();
    expect(s.runtime.continue).toHaveBeenCalledTimes(2);
    expect(s.repo.get("g")?.incidents.at(-1)?.status).toBe("waiting");
    expect(s.repo.get("g")?.incidents.at(-1)?.message).toContain("2 次上限");
  });
  it("quietly honors a manual stop during verification and clears blockers handled in the source session", async () => {
    const s = setup(); await s.check();
    s.observations.set(target.id, observation({ manuallyStopped: true })); await s.check();
    expect(s.repo.get("g")?.incidents[0].status).toBe("dismissed"); expect(s.runtime.notify).not.toHaveBeenCalled();
    const other = setup(); other.runtime.evaluate.mockResolvedValue({ action: "decision", reason: "需要决定业务方案" }); await other.check();
    other.observations.set(target.id, observation({ revision: "user-handled:4", runId: "user-handled", hasProgress: true, terminal: undefined, session: { ...observation().session, status: "running" } })); await other.check();
    expect(other.repo.get("g")?.incidents[0].status).toBe("dismissed");
  });
  it("bounds recoveries across repeated failures and keeps permission/ownership checks", async () => {
    const s = setup();
    for (let i = 0; i < 2; i++) {
      s.observations.set(target.id, observation({ revision: `failure:${i}` })); await s.check();
      s.observations.set(target.id, observation({ revision: `progress:${i}`, terminal: undefined, hasProgress: true, session: { ...observation().session, status: "running" } })); await s.check();
    }
    s.observations.set(target.id, observation({ revision: "third-failure" })); await s.check();
    expect(s.runtime.continue).toHaveBeenCalledTimes(2);
    expect(s.repo.get("g")?.incidents.at(-1)?.message).toContain("2 次上限");
    const other = setup(); other.observations.set(target.id, observation({ session: { ...observation().session, canResume: false, occupancy: "owned-externally" } })); await other.check();
    expect(other.runtime.continue).not.toHaveBeenCalled();
  });
  it("retains original question IDs and options, rejects stale/invalid answers, and answers once", async () => {
    const s = setup(); const question = { id: "original-question", text: "选择价格方案", options: [{ label: "低价", description: "影响收益" }] };
    s.observations.set(target.id, observation({ questions: [question], session: { ...observation().session, status: "running" }, terminal: undefined })); await s.check();
    const incident = s.repo.get("g")!.incidents[0];
    expect(incident.question?.id).toBe(question.id); expect(s.runtime.continue).not.toHaveBeenCalled();
    await expect(s.service.answer("g", incident.id, "低价", [8])).rejects.toThrow("不匹配");
    await s.service.answer("g", incident.id, "低价", [0]);
    expect(s.runtime.answer).toHaveBeenCalledWith(target, question.id, "低价", [0]);
    await expect(s.service.answer("g", incident.id, "低价", [0])).rejects.toThrow("已处理");
    expect(s.runtime.answer).toHaveBeenCalledTimes(1);
    const stale = setup(); stale.observations.set(target.id, observation({ questions: [question] })); await stale.check();
    const staleId = stale.repo.get("g")!.incidents[0].id; stale.observations.set(target.id, observation());
    await expect(stale.service.answer("g", staleId, "低价", [0])).rejects.toThrow("失效");
  });
  it("uses configuration snapshots until explicitly applied and journals the owner's downstream handoff", async () => {
    const s = setup(); const downstream = { ...target, id: "claude:downstream", agentType: "claude-code" as const, title: "验收会话" };
    s.group.monitoring!.targets.push(downstream);
    s.observations.set(downstream.id, observation({ session: { ...downstream, status: "idle", updated: "2026-10-28", canResume: true }, revision: "downstream:0", terminal: undefined }));
    s.runtime.evaluate.mockResolvedValue({ action: "handoff", targetSessionId: downstream.id, reason: "开发已产出，原约定的验收未衔接", message: "成果 /project/report.md，交付验收" });
    await s.check(); expect(s.runtime.handoff).toHaveBeenCalledTimes(1);
    expect(s.runtime.handoff.mock.calls[0][0].group.ownerId).toBe("owner");
    s.group.monitoring!.supervisorId = "b"; await s.check(); expect(s.repo.get("g")?.group.monitoring?.supervisorId).toBe("a");
    s.service.apply("g"); expect(s.repo.get("g")?.group.monitoring?.supervisorId).toBe("b");
  });
  it("admits one intervention when multiple groups monitor the same original session", async () => {
    const s = setup(); s.groups.push({ ...structuredClone(s.group), id: "other-group" });
    await s.check(); expect(s.runtime.continue).toHaveBeenCalledTimes(1);
    expect(s.repo.get("other-group")?.incidents[0].message).toContain("其他群");
  });
});
