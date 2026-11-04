import { beforeEach, expect, it, vi } from "vitest";
import type { SQLiteSupervisionRepository, SupervisionState, SessionObservation } from "@agent/core";
import { groupFixture } from "../../../core/src/domain/collaboration/__tests__/fixtures";
const mocks = vi.hoisted(() => ({ create: vi.fn(), execute: vi.fn(), permission: vi.fn(), enqueue: vi.fn(), snapshot: vi.fn(), get: vi.fn(), goals: vi.fn(), notify: vi.fn() }));
vi.mock("../collaboration/runtime", () => ({ ServerCollaborationRuntime: class { createSession = mocks.create; execute = mocks.execute; answer = vi.fn(); } }));
vi.mock("../../app/api/agent-host", () => ({ agentHost: {} }));
vi.mock("../web-push-service.mjs", () => ({ getWebPushService: () => ({ notifySession: mocks.notify }) }));
vi.mock("../native-runtime-service", () => ({ isNativeSessionId: (id: string) => id.startsWith("codex:"), getNativeRuntimeService: () => ({ setPermissionMode: mocks.permission, enqueueMessage: mocks.enqueue, snapshot: mocks.snapshot, get: mocks.get, getGoals: mocks.goals }) }));
import { ServerSupervisionRuntime } from "./runtime";
function setup() {
  const group = groupFixture(); group.monitoring = { supervisorId: "a", targets: [{ id: "codex:source", agentType: "codex", cwd: "/project", title: "开发任务" }, { id: "codex:target", agentType: "codex", cwd: "/project", title: "交付任务" }] };
  group.members[1].model = { id: "selected-model" }; group.members[1].role = "只看交付断档";
  let state: SupervisionState = { groupId: "g", group, generation: 0, paused: false, updatedAt: "2026-10-28", cursors: {}, incidents: [], sessions: {} };
  const appendMessage = vi.fn();
  const repo = { appendMessage, get: () => structuredClone(state), save: (next: SupervisionState) => { state = structuredClone(next); return true; } } as unknown as SQLiteSupervisionRepository;
  const runtime = new ServerSupervisionRuntime(repo);
  const observation: SessionObservation = { session: { ...group.monitoring.targets[0], updated: "2026-10-28", status: "failed", canResume: true }, revision: "r1:3", questions: [], manuallyStopped: false, context: "产物 /project/result.md", terminal: "error" };
  return { runtime, state, observation, appendMessage };
}
beforeEach(() => {
  vi.resetAllMocks(); mocks.create.mockResolvedValue("codex:diagnostic"); mocks.permission.mockResolvedValue({});
  mocks.enqueue.mockImplementation(async (_id, message) => ({ state: { active: { id: "queued-message", sourceMessageId: message.sourceMessageId, status: "active" }, queued: [], history: [] }, started: { runId: "downstream-run" } }));
});
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
  const { runtime, state, observation, appendMessage } = setup();
  state.group.members[1].agentType = "opencode";
  mocks.execute.mockResolvedValue({ text: JSON.stringify({ action: "continue", reason: "暂时中断", message: "核对已有成果后继续" }) });
  expect((await runtime.evaluate(state, observation, new AbortController().signal)).action).toBe("continue");
  expect(mocks.execute.mock.calls[0][0].member.model.id).toBe("selected-model");
  expect(mocks.execute.mock.calls[0][0].prompt).toContain("只看交付断档");
  expect(mocks.permission).toHaveBeenCalledWith("codex:diagnostic", "request-approval");
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(appendMessage.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
    expect.objectContaining({ direction: "received", sender: "监管巡检", senderAgentType: undefined, recipient: "开发", recipientAgentType: "opencode", content: mocks.execute.mock.calls[0][0].prompt }),
    expect.objectContaining({ direction: "sent", sender: "开发", senderAgentType: "opencode", content: JSON.stringify({ action: "continue", reason: "暂时中断", message: "核对已有成果后继续" }) }),
  ]));
  state.group.members[1].model = undefined;
  await runtime.evaluate(state, observation, new AbortController().signal);
  expect(mocks.create).toHaveBeenCalledTimes(2); // Clearing a model must not inherit the previous native thread's model.
  expect(mocks.execute.mock.calls[1][0].member.model).toBeUndefined();
});
it("keeps diagnostic execution steps in the group instead of only retaining the final reply", async () => {
  const { runtime, state, observation, appendMessage } = setup();
  mocks.execute.mockImplementation(async (_input, progress) => {
    progress({ text: "正在使用 read_file" });
    progress({ text: "一个工具步骤已结束" });
    return { text: JSON.stringify({ action: "observe", reason: "已核对已有成果" }) };
  });
  await runtime.evaluate(state, observation, new AbortController().signal);
  expect(appendMessage.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
    expect.objectContaining({ direction: "activity", title: "诊断执行动态", content: "正在使用 read_file" }),
    expect.objectContaining({ direction: "activity", title: "诊断执行动态", content: "一个工具步骤已结束" }),
  ]));
});
it("asks the main Agent to compose an evidenced handoff before admitting it with a stable dedupe ID", async () => {
  const { runtime, state, observation, appendMessage } = setup();
  state.group.members[1].agentType = "opencode";
  state.group.monitoring!.targets[1].agentType = "zcode";
  vi.spyOn(runtime, "observe").mockResolvedValue({ ...observation, terminal: undefined, session: { ...observation.session, status: "idle" } });
  mocks.execute.mockResolvedValue({ text: JSON.stringify({ approved: true, message: "已有产物 /project/result.md；按约定验证接口" }) });
  const receipt = await runtime.handoff(state, state.group.monitoring!.targets[0], state.group.monitoring!.targets[1], "原任务验收未接上", "action-1", new AbortController().signal);
  expect(mocks.execute.mock.calls[0][0].member.id).toBe("owner");
  expect(mocks.enqueue).toHaveBeenCalledWith("codex:target", expect.objectContaining({ sourceMessageId: "supervision:action-1", content: expect.stringContaining("/project/result.md") }), "web");
  expect(receipt).toMatchObject({ accepted: true, runId: "downstream-run" });
  expect(appendMessage.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: "群主收到交接请求", senderAgentType: "opencode", recipient: "总控", recipientAgentType: "codex" }),
    expect.objectContaining({ title: "群主交接回复", sender: "总控", senderAgentType: "codex" }),
    expect.objectContaining({ direction: "sent", sender: "总控", senderAgentType: "codex", recipient: "交付任务", recipientAgentType: "zcode", content: mocks.enqueue.mock.calls[0][1].content }),
    expect.objectContaining({ direction: "received", status: "verifying", sender: "交付任务", senderAgentType: "zcode", recipientAgentType: "codex" }),
  ]));
});

it("keeps the supervisor identity on reminders sent to the user", async () => {
  const { runtime, state, appendMessage } = setup();
  state.group.members[1].agentType = "opencode";
  await runtime.notify(state.group, {
    id: "incident", groupId: "g", sessionId: "codex:source", sessionTitle: "开发任务",
    fingerprint: "question", kind: "question", status: "waiting", message: "请核对下一步",
    createdAt: state.updatedAt, updatedAt: state.updatedAt, attempts: 0,
  });
  expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
    direction: "sent", sender: "开发", senderAgentType: "opencode", recipient: "你",
  }));
});

it("records the exact continuation message and a failed send without claiming receipt or recovery", async () => {
  const { runtime, state, observation, appendMessage } = setup();
  vi.spyOn(runtime, "observe").mockResolvedValue({ ...observation, terminal: undefined, session: { ...observation.session, status: "idle" } });
  mocks.enqueue.mockRejectedValue(new Error("后端拒绝接收"));
  await expect(runtime.continue(state.group.monitoring!.targets[1], "核对成果再继续", "failed-action", { groupId: "g", sender: "监工" })).rejects.toThrow("后端拒绝接收");
  const messages = appendMessage.mock.calls.map(call => call[0]);
  expect(messages).toEqual([
    expect.objectContaining({ direction: "sent", status: "executing", content: mocks.enqueue.mock.calls[0][1].content }),
    expect.objectContaining({ title: "接续指令未完成发送", content: "后端拒绝接收", status: "waiting" }),
  ]);
  expect(messages.some(message => message.title === "原会话已接收指令")).toBe(false);
});

it("reports admission without a run as queued in both the receipt and group journal", async () => {
  const { runtime, state, observation, appendMessage } = setup();
  vi.spyOn(runtime, "observe").mockResolvedValue({ ...observation, terminal: undefined, session: { ...observation.session, status: "idle" } });
  mocks.enqueue.mockResolvedValue({ state: { active: { id: "queue-1", sourceMessageId: "supervision:action-1", status: "active" }, queued: [], history: [] } });
  const receipt = await runtime.continue(state.group.monitoring!.targets[0], "继续", "action-1", { groupId: "g", sender: "监工" });
  expect(receipt).toMatchObject({ id: "action-1", accepted: true, messageId: "queue-1", status: "queued" });
  expect(receipt.runId).toBeUndefined();
  expect(appendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ title: "接续指令已排队", status: "queued", content: expect.stringContaining("尚未开始执行") }));
});

it("does not attribute an older queued message's newly started run to the new supervision reply", async () => {
  const { runtime, state, observation } = setup();
  vi.spyOn(runtime, "observe").mockResolvedValue({ ...observation, terminal: undefined, session: { ...observation.session, status: "idle" } });
  mocks.enqueue.mockResolvedValue({ state: {
    active: { id: "older", sourceMessageId: "supervision:older-action", status: "active" },
    queued: [{ id: "newer", sourceMessageId: "supervision:action-1", status: "queued" }], history: [],
  }, started: { runId: "older-run" } });
  const receipt = await runtime.continue(state.group.monitoring!.targets[0], "继续", "action-1");
  expect(receipt).toMatchObject({ messageId: "newer", status: "queued" });
  expect(receipt.runId).toBeUndefined();
});

it.each([false, true])("inspects the queue without resuming and requires a matching run for running status (%s)", async matching => {
  const { runtime, state } = setup(); const target = state.group.monitoring!.targets[0];
  mocks.goals.mockResolvedValue({ active: { id: "queue-1", sourceMessageId: "supervision:action-1", status: "active" }, queued: [], history: [] });
  mocks.snapshot.mockResolvedValue({ runId: "run-1", queueItemId: matching ? "queue-1" : "unrelated" });
  expect(await runtime.interventionStatus(target, "action-1")).toMatchObject({ messageId: "queue-1", status: matching ? "running" : "queued", runId: matching ? "run-1" : undefined });
  expect(mocks.goals).toHaveBeenCalledWith(target.id, "web", false);
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it.each(["completed", "failed", "cancelled"])("reads the correlated %s outcome from durable history", async status => {
  const { runtime, state } = setup();
  mocks.goals.mockResolvedValue({ active: null, queued: [], history: [{ id: "queue-1", sourceMessageId: "supervision:action-1", status, lastReason: "原生执行结果" }] });
  mocks.snapshot.mockResolvedValue({ runId: null });
  expect(await runtime.interventionStatus(state.group.monitoring!.targets[0], "action-1")).toMatchObject({ messageId: "queue-1", status, reason: "原生执行结果" });
});
