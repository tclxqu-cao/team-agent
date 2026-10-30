import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  SQLiteProjectStore,
  type AgentEvent,
  type CollaborationExecution,
  type CollaborationGroup,
  type CollaborationMember,
  type CollaborationProgress,
  type CollaborationRuntime,
  type TokenUsage,
} from "@agent/core";
import { agentHost } from "../../app/api/agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
} from "../native-runtime-service";
import { getServerBaseDir } from "../server-data-dir";

const runFile = promisify(execFile);

export class ServerCollaborationRuntime implements CollaborationRuntime {
  async prepareWorkspace(
    group: CollaborationGroup,
    discussionId: string,
    taskId: string,
  ) {
    const fallback = {
      cwd: group.cwd,
      isolated: false,
      note: "当前目录包含未提交内容或不支持 Git 隔离，保留现有状态并串行执行。",
    };
    try {
      const { stdout: status } = await runFile(
        "git",
        ["status", "--porcelain", "--untracked-files=normal"],
        { cwd: group.cwd, timeout: 10000 },
      );
      if (status.trim()) return fallback;
      const { stdout: root } = await runFile(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd: group.cwd, timeout: 10000 },
      );
      // Only whole-project roots can be copied without changing relative-path semantics.
      if ((await realpath(root.trim())) !== (await realpath(group.cwd)))
        return fallback;
      const { stdout: head } = await runFile("git", ["rev-parse", "HEAD"], {
        cwd: group.cwd,
        timeout: 10000,
      });
      const parent = join(
        getServerBaseDir(),
        ".agent-data",
        "collaboration-workspaces",
        group.id,
        discussionId,
      );
      await mkdir(parent, { recursive: true });
      const cwd = join(parent, taskId);
      await runFile("git", ["worktree", "add", "--detach", cwd, head.trim()], {
        cwd: group.cwd,
        timeout: 30000,
      });
      return { cwd, isolated: true };
    } catch {
      return fallback;
    }
  }
  async createSession(
    group: CollaborationGroup,
    member: CollaborationMember,
    cwd: string,
  ): Promise<string> {
    if (member.agentType !== "customer-agent") {
      return (
        await getNativeRuntimeService().create({
          agentType: member.agentType,
          title: `[${group.name}] ${member.name}`,
          cwd,
          ...(group.projectId ? { projectId: group.projectId } : {}),
        })
      ).id;
    }
    // The built-in host resolves cwd through its project repository, unlike native adapters.
    const projectId = `collaboration-${group.id}-${createHash("sha256").update(cwd).digest("hex").slice(0, 24)}`;
    const projects = new SQLiteProjectStore(getServerBaseDir());
    if (!(await projects.get(projectId))) {
      const now = new Date().toISOString();
      await projects.create({
        id: projectId,
        name: `${group.name} · 工作区`,
        description: cwd,
        created: now,
        updated: now,
      });
    }
    const session = await agentHost.createSession(
      `[${group.name}] ${member.name}`,
      projectId,
    );
    await agentHost
      .getSessionStore()
      .update(session.id, {
        metadata: { ...session.metadata, collaborationGroupId: group.id },
      });
    return session.id;
  }
  async execute(
    input: CollaborationExecution,
    onProgress: (progress: CollaborationProgress) => void,
  ): Promise<{ text: string; usage?: TokenUsage }> {
    if (input.signal.aborted) throw new Error("协作已停止");
    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | undefined;
      let settled = false;
      const finish = (error?: Error, text?: string, usage?: TokenUsage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe?.();
        input.signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else
          resolve({
            text: text || "成员完成执行，但未返回文字成果。",
            ...(usage ? { usage } : {}),
          });
      };
      const aborted = () => {
        void this.abort(input.sessionId).catch(() => undefined);
        finish(new Error("执行已停止"));
      };
      const timer = setTimeout(
        () => {
          void this.abort(input.sessionId).catch(() => undefined);
          finish(
            new Error("成员执行超过 30 分钟，已中断，请由群主核对后继续。"),
          );
        },
        30 * 60 * 1000,
      );
      input.signal.addEventListener("abort", aborted, { once: true });
      const consume = (event: AgentEvent) => {
        if (settled) return;
        if (event.type === "done")
          finish(undefined, event.finalText, event.usage);
        else if (event.type === "error") finish(new Error(event.message));
        else if (event.type === "turn_aborted")
          finish(new Error("成员执行被中断"));
        else if (event.type === "tool_call")
          onProgress({ text: `正在使用 ${event.toolCall.name}` });
        else if (event.type === "tool_result")
          onProgress({
            text: event.result.isError
              ? "工具执行失败，成员正在处理"
              : "一个工具步骤已结束",
          });
        else if (event.type === "ask_user")
          onProgress({
            text: event.question,
            question: { id: event.questionId, options: event.options },
          });
        else if (event.type === "approval_resolved")
          onProgress({
            text: "问题已处理",
            resolvedQuestionId: event.questionId,
          });
      };
      void (async () => {
        try {
          if (isNativeSessionId(input.sessionId)) {
            const service = getNativeRuntimeService();
            await service.startRun(
              input.sessionId,
              input.prompt,
              undefined,
              "web",
              input.member.model ? { model: input.member.model } : undefined,
            );
            if (input.signal.aborted || settled) {
              await this.abort(input.sessionId);
              return;
            }
            unsubscribe = await service.subscribe(
              input.sessionId,
              0,
              ({ event }) => consume(event),
            );
          } else {
            const afterEventId = agentHost.getLatestEventId(input.sessionId);
            const admission = agentHost.startRun(
              input.prompt,
              input.sessionId,
              undefined,
              input.member.profileId
                ? { profileId: input.member.profileId }
                : {},
            );
            unsubscribe = agentHost.subscribe(
              input.sessionId,
              consume,
              afterEventId,
            );
            await admission.completion;
            if (!settled) finish(new Error("成员结束执行但没有提交结果"));
          }
          if (settled) unsubscribe?.();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }
  /** 验收命令在任务目录以 sh -c 执行；超时或协作中止按失败处理，输出截尾返回。 */
  async verify(
    cwd: string,
    command: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let settled = false;
      const collect = (chunk: Buffer) => {
        output += chunk;
        if (output.length > 60000) output = output.slice(-60000);
      };
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve({ ok, output: output.slice(-60000) });
      };
      const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);
      const onAbort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (error) => {
        output += `\n${error.message}`;
        finish(false);
      });
      child.on("close", (code) => finish(code === 0));
    });
  }
  async abort(sessionId: string): Promise<void> {
    if (isNativeSessionId(sessionId))
      await getNativeRuntimeService().abort(sessionId);
    else agentHost.abort(sessionId);
  }
  async answer(
    sessionId: string,
    questionId: string,
    answer: string,
    selectedIndices?: number[],
  ): Promise<boolean> {
    return isNativeSessionId(sessionId)
      ? getNativeRuntimeService().answerQuestion(questionId, {
          answer,
          selectedIndices,
        })
      : agentHost.answerQuestion(questionId, answer, selectedIndices);
  }
}
