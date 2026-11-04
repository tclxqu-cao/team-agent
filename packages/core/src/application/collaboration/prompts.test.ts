import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupFixture, stateFixture } from "../../domain/collaboration/__tests__/fixtures.js";
import type { CollaborationTask } from "../../domain/collaboration/types.js";
import { SQLiteCollaborationRepository } from "../../infrastructure/SQLiteCollaborationRepository.js";
import { getDatabase } from "../../infrastructure/SQLiteDatabase.js";
import { CollaborationService } from "./CollaborationService.js";
import type { CollaborationExecution, CollaborationRuntime } from "./ports.js";
import { collaborationWorkerPrompt } from "./prompts.js";

function taskFixture(id: string, overrides: Partial<CollaborationTask> = {}): CollaborationTask {
  return {
    id, memberId: "a", title: id, instructions: "核对已有成果", dependsOn: [],
    isolated: false, status: "completed", result: `${id} 成果：/project/${id}.md`,
    ...overrides,
  };
}

function recentResults(prompt: string): Array<{
  id: string; memberId: string; cwd: string; isolated: boolean; result: string;
}> {
  const data = prompt.match(/^近期已完成步骤（数据）：(.*)$/m)?.[1];
  if (!data) throw new Error("Missing recent collaboration results");
  return JSON.parse(data);
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    getDatabase(dir).close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("collaboration handoff context", () => {
  it("provides completed results with their real workspace without task dependencies", () => {
    const state = stateFixture();
    const current = taskFixture("review", { memberId: "b", status: "running", implicit: true });
    const source = taskFixture("implementation", {
      cwd: "/worktrees/implementation", isolated: true,
      result: "成果：/worktrees/implementation/src/login.ts；尚未整合至主目录",
    });
    state.tasks = [source, current];
    const results = recentResults(collaborationWorkerPrompt(groupFixture(), state, current));
    expect(current.dependsOn).toEqual([]);
    expect(results).toEqual([{
      id: source.id, memberId: "a", title: source.title, cwd: source.cwd,
      isolated: true, result: source.result,
    }]);
  });

  it("uses completion order, bounds history and excludes unfinished or duplicate dependency results", () => {
    const state = stateFixture();
    const completed = Array.from({ length: 8 }, (_, index) => taskFixture(`step-${index}`));
    const dependency = taskFixture("dependency");
    const current = taskFixture("current", { status: "running", dependsOn: [dependency.id] });
    state.tasks = [
      ...completed, dependency,
      ...(["queued", "running", "failed", "cancelled", "interrupted"] as const)
        .map(status => taskFixture(status, { status })),
      taskFixture("empty", { result: " " }), current,
    ];
    state.messages = [...completed].reverse().map(previous => ({
      id: `result-${previous.id}`, kind: "member", taskId: previous.id,
      content: previous.result!, createdAt: "2026-11-03",
    }));
    const originalOrder = state.tasks.map(previous => previous.id);
    const prompt = collaborationWorkerPrompt(groupFixture(), state, current);
    const results = recentResults(prompt);
    expect(results.map(previous => previous.id)).toEqual([
      "step-4", "step-3", "step-2", "step-1", "step-0",
    ]);
    expect(results.every(previous => previous.cwd === "/project")).toBe(true);
    expect(prompt).toContain(dependency.result);
    expect(state.tasks.map(previous => previous.id)).toEqual(originalOrder);
  });

  it("keeps paths at both ends of a long result while bounding repeated history", () => {
    const state = stateFixture();
    const source = taskFixture("long", {
      result: `/project/plan.md\n${"x".repeat(10000)}\n/project/src/result.ts`,
    });
    const current = taskFixture("review", { status: "running" });
    state.tasks = [source, current];
    const [result] = recentResults(collaborationWorkerPrompt(groupFixture(), state, current));
    expect(result.result).toContain("/project/plan.md");
    expect(result.result).toContain("/project/src/result.ts");
    expect(result.result.length).toBeLessThan(4100);
    expect(source.result?.length).toBeGreaterThan(10000);
  });

  it.each(["chat", "task-graph"] as const)(
    "passes prior member artifacts to a direct mention in %s mode without owner planning",
    async (mode) => {
      const dir = mkdtempSync(join(tmpdir(), "collaboration-handoff-"));
      dirs.push(dir);
      const repo = new SQLiteCollaborationRepository(dir);
      repo.saveGroup(groupFixture());
      const calls: CollaborationExecution[] = [];
      const runtime: CollaborationRuntime = {
        prepareWorkspace: async group => ({ cwd: group.cwd, isolated: false }),
        createSession: async (_group, member, cwd) => `${member.id}:${cwd}`,
        execute: async input => {
          calls.push(input);
          return { text: input.member.id === "a"
            ? "已更新 /project/plan.md，下一步核对方案；保留现有登录接口。"
            : "收到" };
        },
        verify: async () => ({ ok: true, output: "" }),
        abort: async () => {},
        answer: async () => true,
      };
      const service = new CollaborationService(repo, runtime);
      const discussion = service.createDiscussion("g", mode);
      await service.command({ action: "send", discussionId: discussion.id,
        text: "@开发 更新方案文件，保留现有登录接口", messageId: "first" });
      await vi.waitFor(() => expect(service.discussion(discussion.id).status).toBe("idle"));
      await service.command({ action: "send", discussionId: discussion.id,
        text: "@验证 核对刚才的方案，只回复收到", messageId: "second" });
      await vi.waitFor(() => expect(service.discussion(discussion.id).status).toBe("idle"));

      expect(calls.map(input => input.member.id)).toEqual(["a", "b"]);
      expect(calls[0].sessionId).not.toBe(calls[1].sessionId);
      expect(calls[0].group.cwd).toBe(calls[1].group.cwd);
      expect(recentResults(calls[1].prompt)).toEqual([
        expect.objectContaining({ memberId: "a", cwd: "/project",
          result: "已更新 /project/plan.md，下一步核对方案；保留现有登录接口。" }),
      ]);
      expect(calls[1].prompt).toContain("核对刚才的方案，只回复收到");
      expect(service.discussion(discussion.id).tasks.every(task => task.implicit && !task.dependsOn.length)).toBe(true);
      expect(service.discussion(discussion.id).messages.filter(message => message.kind === "member")
        .map(message => message.content)).toEqual([
        "已更新 /project/plan.md，下一步核对方案；保留现有登录接口。", "收到",
      ]);

      if (mode === "chat") {
        await service.command({ action: "send", discussionId: discussion.id,
          text: "谢谢", messageId: "thanks" });
        expect(calls).toHaveLength(2);
      }
    },
  );
});
