import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, CollaborationExecution } from "@agent/core";
import { groupFixture } from "../../../core/src/domain/collaboration/__tests__/fixtures";

const mocks = vi.hoisted(() => ({
  native: {
    startRun: vi.fn(),
    subscribe: vi.fn(),
    abort: vi.fn(),
    answerQuestion: vi.fn(),
  },
  host: {
    startRun: vi.fn(),
    subscribe: vi.fn(),
    getLatestEventId: vi.fn(),
    abort: vi.fn(),
    answerQuestion: vi.fn(),
  },
}));
vi.mock("../../app/api/agent-host", () => ({ agentHost: mocks.host }));
vi.mock("../native-runtime-service", () => ({
  getNativeRuntimeService: () => mocks.native,
  isNativeSessionId: (id: string) => id.startsWith("codex:"),
}));
vi.mock("../server-data-dir", () => ({
  getServerBaseDir: () => "/tmp/collaboration-adapter-test",
}));
import { ServerCollaborationRuntime } from "./runtime";

function input(sessionId = "codex:member"): CollaborationExecution {
  const group = groupFixture();
  return {
    group,
    member: group.members[1],
    sessionId,
    prompt: "执行任务",
    signal: new AbortController().signal,
  };
}
beforeEach(() => vi.resetAllMocks());
describe("collaboration runtime adapters", () => {
  it("uses the selected native model, delivers approvals and cleans up a synchronous terminal replay", async () => {
    const stop = vi.fn(),
      events: unknown[] = [];
    mocks.native.startRun.mockResolvedValue({ runId: "run" });
    mocks.native.subscribe.mockImplementation(
      async (_id, _sequence, listener) => {
        listener({
          event: {
            type: "ask_user",
            questionId: "q",
            question: "是否继续？",
            options: [{ label: "继续", description: "确认" }],
          },
        });
        listener({ event: { type: "done", finalText: "实际成果" } });
        return stop;
      },
    );
    const execution = input();
    execution.member = {
      ...execution.member,
      model: { id: "chosen", providerID: "provider" },
    };
    expect(
      await new ServerCollaborationRuntime().execute(execution, (event) =>
        events.push(event),
      ),
    ).toEqual({ text: "实际成果" });
    expect(mocks.native.startRun).toHaveBeenCalledWith(
      "codex:member",
      "执行任务",
      undefined,
      "web",
      { model: { id: "chosen", providerID: "provider" } },
    );
    expect(events).toContainEqual({
      text: "是否继续？",
      question: { id: "q", options: [{ label: "继续", description: "确认" }] },
    });
    expect(stop).toHaveBeenCalledOnce();
  });
  it("does not mistake a previous built-in turn's done event for the new result", async () => {
    let listener: ((event: AgentEvent) => void) | undefined;
    mocks.host.getLatestEventId.mockReturnValue(19);
    mocks.host.startRun.mockImplementation(() => ({
      completion: Promise.resolve().then(() =>
        listener?.({ type: "done", finalText: "新成果" }),
      ),
    }));
    mocks.host.subscribe.mockImplementation((_id, callback, after) => {
      listener = callback;
      if (after < 19) callback({ type: "done", finalText: "旧成果" });
      return vi.fn();
    });
    expect(
      await new ServerCollaborationRuntime().execute(
        input("builtin"),
        () => {},
      ),
    ).toEqual({ text: "新成果" });
    expect(mocks.host.subscribe.mock.calls[0][2]).toBe(19);
  });
  it("pins a built-in member's saved model profile without changing global settings", async () => {
    const execution = input("builtin");
    execution.member = {
      ...execution.member,
      agentType: "customer-agent",
      profileId: "selected-profile",
    };
    mocks.host.getLatestEventId.mockReturnValue(0);
    mocks.host.subscribe.mockImplementation((_id, callback) => {
      callback({ type: "done", finalText: "完成" });
      return vi.fn();
    });
    mocks.host.startRun.mockReturnValue({ completion: Promise.resolve() });
    await new ServerCollaborationRuntime().execute(execution, () => {});
    expect(mocks.host.startRun).toHaveBeenCalledWith(
      "执行任务",
      "builtin",
      undefined,
      { profileId: "selected-profile" },
    );
  });
  it("aborts a native run even if cancellation arrives while admission is pending", async () => {
    let admit!: () => void;
    mocks.native.startRun.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
    );
    mocks.native.abort.mockResolvedValue(undefined);
    const controller = new AbortController(),
      execution = { ...input(), signal: controller.signal };
    const result = new ServerCollaborationRuntime().execute(
      execution,
      () => {},
    );
    const rejected = expect(result).rejects.toThrow("停止");
    controller.abort();
    admit();
    await rejected;
    await vi.waitFor(() =>
      expect(mocks.native.abort).toHaveBeenCalledWith(execution.sessionId),
    );
    expect(mocks.native.subscribe).not.toHaveBeenCalled();
  });
});
