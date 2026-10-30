import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type {
  CollaborationDiscussionState,
  CollaborationExecution,
  CollaborationGroup,
  CollaborationRuntime,
} from "@agent/core";

// 受控的 agent 运行时替身：记录调用、按测试注入执行结果，避免 e2e 触碰真实 CLI。
const runtimeState = vi.hoisted(() => ({
  calls: [] as Array<{ member: string; sessionId: string }>,
  executeImpl: null as null | ((input: {
    member: { id: string };
    sessionId: string;
  }) => Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }>),
}));
vi.mock("./runtime", () => ({
  ServerCollaborationRuntime: class implements CollaborationRuntime {
    async prepareWorkspace(group: CollaborationGroup) {
      return { cwd: group.cwd, isolated: false };
    }
    async createSession(
      _group: CollaborationGroup,
      member: { id: string },
      cwd: string,
    ) {
      return `${member.id}:${cwd}`;
    }
    async execute(input: CollaborationExecution) {
      runtimeState.calls.push({
        member: input.member.id,
        sessionId: input.sessionId,
      });
      return runtimeState.executeImpl
        ? runtimeState.executeImpl(input)
        : { text: "已处理" };
    }
    async verify() {
      return { ok: true, output: "" };
    }
    async abort() {}
    async answer() {
      return true;
    }
  },
}));

// 数据目录与工作区白名单先就位，再加载路由模块，让单例服务落在临时目录里。
const dataDir = mkdtempSync(join(tmpdir(), "collab-e2e-data-"));
const workspaceDir = join(dataDir, "workspace");
mkdirSync(workspaceDir);
process.env.AGENT_DATA_DIR = dataDir;
process.env.AGENT_WEB_ROOTS = dataDir;
const { POST } = await import("../../app/api/collaboration/route");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/collaboration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const groupPayload = {
  name: "e2e 群",
  cwd: workspaceDir,
  ownerId: "owner",
  maxParallel: 3,
  members: [
    { id: "owner", name: "总控", agentType: "codex", role: "" },
    { id: "a", name: "开发", agentType: "codex", role: "实现" },
    { id: "b", name: "验证", agentType: "claude-code", role: "" },
  ],
};

async function waitForDiscussion(
  discussionId: string,
  predicate: (state: CollaborationDiscussionState) => boolean,
): Promise<CollaborationDiscussionState> {
  let latest: CollaborationDiscussionState | null = null;
  await vi.waitFor(async () => {
    const response = await post({ action: "discussion", discussionId });
    expect(response.status).toBe(200);
    latest = (await response.json()) as CollaborationDiscussionState;
    expect(predicate(latest)).toBe(true);
  });
  return latest!;
}

describe("协作群路由层端到端（真实 route → zod → service → SQLite，替身 agent 运行时）", () => {
  it("chat 模式 @提及经路由直达成员，群主不被唤醒，完成回到待命并累计用量", async () => {
    runtimeState.calls.length = 0;
    runtimeState.executeImpl = async (input) =>
      input.member.id === "owner"
        ? {
            text: JSON.stringify({ action: "finish", message: "完成" }),
            usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
          }
        : {
            text: "已处理",
            usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
          };
    const group = (await (
      await post({ action: "createGroup", group: groupPayload })
    ).json()) as CollaborationGroup;
    const created = (await (
      await post({ action: "createDiscussion", groupId: group.id, mode: "chat" })
    ).json()) as CollaborationDiscussionState;
    expect(created.mode).toBe("chat");

    const sendResponse = await post({
      action: "send",
      discussionId: created.id,
      text: "@开发 修一下登录超时",
      messageId: "m1",
    });
    expect(sendResponse.status).toBe(200);
    const afterSend = (await sendResponse.json()) as CollaborationDiscussionState;
    expect(afterSend.tasks).toHaveLength(1);
    expect(afterSend.tasks[0]).toMatchObject({
      memberId: "a",
      implicit: true,
    });

    const state = await waitForDiscussion(
      created.id,
      (s) => s.status === "idle",
    );
    expect(runtimeState.calls.map((call) => call.member)).toEqual(["a"]);
    expect(state.tasks[0]).toMatchObject({ status: "completed", result: "已处理" });
    expect(state.usage).toEqual({ inputTokens: 20, outputTokens: 2 });

    const before = runtimeState.calls.length;
    await post({
      action: "send",
      discussionId: created.id,
      text: "谢谢",
      messageId: "m2",
    });
    const quiet = await waitForDiscussion(created.id, (s) =>
      s.messages.some((message) => message.content === "谢谢"),
    );
    expect(quiet.status).toBe("idle");
    expect(runtimeState.calls.length).toBe(before);
  });

  it("默认编排模式下 @成员 同样直达，不触发群主规划", async () => {
    runtimeState.calls.length = 0;
    runtimeState.executeImpl = async () => ({ text: "已处理" });
    const group = (await (
      await post({ action: "createGroup", group: groupPayload })
    ).json()) as CollaborationGroup;
    const created = (await (
      await post({ action: "createDiscussion", groupId: group.id })
    ).json()) as CollaborationDiscussionState;
    expect(created.mode ?? "task-graph").toBe("task-graph");
    await post({
      action: "send",
      discussionId: created.id,
      text: "@开发 修一下登录超时",
      messageId: "m1",
    });
    const state = await waitForDiscussion(created.id, (s) => s.status === "idle");
    expect(runtimeState.calls.map((call) => call.member)).toEqual(["a"]);
    expect(state.tasks[0]).toMatchObject({ memberId: "a", implicit: true, status: "completed" });
  });

  it("task-graph 讨论仍走群主规划并完成交付", async () => {
    runtimeState.calls.length = 0;
    runtimeState.executeImpl = async (input) =>
      input.member.id === "owner"
        ? {
            text: JSON.stringify({ action: "finish", message: "完成" }),
            usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
          }
        : { text: "已处理" };
    const group = (await (
      await post({ action: "createGroup", group: groupPayload })
    ).json()) as CollaborationGroup;
    const created = (await (
      await post({ action: "createDiscussion", groupId: group.id })
    ).json()) as CollaborationDiscussionState;
    expect(created.mode ?? "task-graph").toBe("task-graph");
    await post({
      action: "send",
      discussionId: created.id,
      text: "帮我收尾",
      messageId: "m1",
    });
    const state = await waitForDiscussion(created.id, (s) => s.status === "completed");
    expect(runtimeState.calls.map((call) => call.member)).toEqual(["owner"]);
    expect(state.messages.some((m) => m.kind === "owner" && m.content === "完成")).toBe(true);
  });

  it("setMode 可切换讨论模式", async () => {
    const group = (await (
      await post({ action: "createGroup", group: groupPayload })
    ).json()) as CollaborationGroup;
    const created = (await (
      await post({ action: "createDiscussion", groupId: group.id })
    ).json()) as CollaborationDiscussionState;
    const switched = (await (
      await post({ action: "setMode", discussionId: created.id, mode: "chat" })
    ).json()) as CollaborationDiscussionState;
    expect(switched.mode).toBe("chat");
    const back = (await (
      await post({ action: "setMode", discussionId: created.id, mode: "task-graph" })
    ).json()) as CollaborationDiscussionState;
    expect(back.mode).toBe("task-graph");
  });

  it("结构非法返回 400，业务校验拒绝返回 409", async () => {
    const badMode = await post({
      action: "setMode",
      discussionId: "whatever",
      mode: "bogus",
    });
    expect(badMode.status).toBe(400);
    const missingGroup = await post({ action: "createDiscussion" });
    expect(missingGroup.status).toBe(400);
    // 空白文本通过路由 schema（min(1) 按长度），由服务层业务校验拒绝。
    const emptyText = await post({
      action: "send",
      discussionId: "whatever",
      text: "   ",
      messageId: "m1",
    });
    expect(emptyText.status).toBe(409);
  });
});
