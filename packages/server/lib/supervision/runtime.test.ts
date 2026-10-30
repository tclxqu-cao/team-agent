import { beforeEach, expect, it, vi } from "vitest";
import type { SQLiteSupervisionRepository, SupervisionState, SessionObservation } from "@agent/core";
import { groupFixture } from "../../../core/src/domain/collaboration/__tests__/fixtures";
const mocks = vi.hoisted(() => ({ create: vi.fn(), execute: vi.fn(), permission: vi.fn(), enqueue: vi.fn(), snapshot: vi.fn(), get: vi.fn() }));
vi.mock("../collaboration/runtime", () => ({ ServerCollaborationRuntime: class { createSession = mocks.create; execute = mocks.execute; answer = vi.fn(); } }));
vi.mock("../../app/api/agent-host", () => ({ agentHost: {} }));
vi.mock("../native-runtime-service", () => ({ isNativeSessionId: (id: string) => id.startsWith("codex:"), getNativeRuntimeService: () => ({ setPermissionMode: mocks.permission, enqueueMessage: mocks.enqueue, snapshot: mocks.snapshot, get: mocks.get }) }));
import { ServerSupervisionRuntime } from "./runtime";
function setup() {
  const group = groupFixture(); group.monitoring = { supervisorId: "a", targets: [{ id: "codex:source", agentType: "codex", cwd: "/project", title: "开发任务" }, { id: "codex:target", agentType: "codex", cwd: "/project", title: "交付任务" }] };
  group.members[1].model = { id: "selected-model" }; group.members[1].role = "只看交付断档";
  let state: SupervisionState = { groupId: "g", group, generation: 0, paused: false, updatedAt: "2026-10-28", cursors: {}, incidents: [], sessions: {} };
  const repo = { get: () => structuredClone(state), save: (next: SupervisionState) => { state = structuredClone(next); return true; } } as unknown as SQLiteSupervisionRepository;
  const runtime = new ServerSupervisionRuntime(repo);
  const observation: SessionObservation = { session: { ...group.monitoring.targets[0], updated: "2026-10-28", status: "failed", canResume: true }, revision: "r1:3", questions: [], manuallyStopped: false, context: "产物 /project/result.md", terminal: "error" };
  return { runtime, state, observation };
}
beforeEach(() => { vi.resetAllMocks(); mocks.create.mockResolvedValue("codex:diagnostic"); mocks.permission.mockResolvedValue({}); mocks.enqueue.mockResolvedValue({ state: {}, started: { runId: "downstream-run" } }); });
it("observes a bounded history and actual text progress while retaining only active source questions", async () => {
  const { runtime, state } = setup(); const target = state.group.monitoring!.targets[0];
  const events = [{ type: "text_chunk", text: "开始核对已有成果" }, { type: "ask_user", questionId: "expired", question: "旧问题" }, { type: "approval_resolved", questionId: "expired" }, { type: "ask_user", questionId: "current", question: "填写凭证", fields: [{ name: "credential", label: "凭证", type: "secret" }] }];
  mocks.snapshot.mockImplementation(async (_id, after) => ({ sessionId: target.id, runId: "run", snapshotRevision: 9, controller: "web", manuallyStopped: false, events: after > 9 ? [] : events.map((event, sequence) => ({ event, sequence: sequence + 1, runId: "run" })) }));
  mocks.get.mockResolvedValue({ ...target, updated: "2026-10-28", status: "running", canResume: true, occupancy: "available", messages: [{ role: "user", content: "原始任务" }], events });
  const observed = await runtime.observe(target);
  expect(mocks.get).toHaveBeenCalledWith(target.id, { limit: 8, view: "core" });
  expect(observed.hasProgress).toBe(true); expect(observed.autoControlAvailable).toBe(true);
  expect(observed.questions).toEqual([expect.objectContaining({ id: "current", requiresSource: true })]);
});
it("runs the chosen supervisor/model with its role in a separate approval-gated diagnostic session", async () => {
  const { runtime, state, observation } = setup();
  mocks.execute.mockResolvedValue({ text: JSON.stringify({ action: "continue", reason: "暂时中断", message: "核对已有成果后继续" }) });
  expect((await runtime.evaluate(state, observation, new AbortController().signal)).action).toBe("continue");
  expect(mocks.execute.mock.calls[0][0].member.model.id).toBe("selected-model");
  expect(mocks.execute.mock.calls[0][0].prompt).toContain("只看交付断档");
  expect(mocks.permission).toHaveBeenCalledWith("codex:diagnostic", "request-approval");
  expect(mocks.enqueue).not.toHaveBeenCalled();
  state.group.members[1].model = undefined;
  await runtime.evaluate(state, observation, new AbortController().signal);
  expect(mocks.create).toHaveBeenCalledTimes(2); // Clearing a model must not inherit the previous native thread's model.
  expect(mocks.execute.mock.calls[1][0].member.model).toBeUndefined();
});
it("asks the main Agent to compose an evidenced handoff before admitting it with a stable dedupe ID", async () => {
  const { runtime, state, observation } = setup();
  vi.spyOn(runtime, "observe").mockResolvedValue({ ...observation, terminal: undefined, session: { ...observation.session, status: "idle" } });
  mocks.execute.mockResolvedValue({ text: JSON.stringify({ approved: true, message: "已有产物 /project/result.md；按约定验证接口" }) });
  const receipt = await runtime.handoff(state, state.group.monitoring!.targets[0], state.group.monitoring!.targets[1], "原任务验收未接上", "action-1", new AbortController().signal);
  expect(mocks.execute.mock.calls[0][0].member.id).toBe("owner");
  expect(mocks.enqueue).toHaveBeenCalledWith("codex:target", expect.objectContaining({ sourceMessageId: "supervision:action-1", content: expect.stringContaining("/project/result.md") }), "web");
  expect(receipt).toMatchObject({ accepted: true, runId: "downstream-run" });
});
