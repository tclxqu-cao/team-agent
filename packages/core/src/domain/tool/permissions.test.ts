import { describe, expect, it, vi } from "vitest";
import type { IToolExecutor, ToolContext } from "./entities.js";
import {
  PermissionAwareToolExecutor,
  ToolPermissionGate,
  classifyToolPermission,
  normalizeToolPermissionMode,
  type ToolPermissionMode,
} from "./permissions.js";

const ctx = (sessionId = "session-a"): ToolContext => ({
  sessionId,
  workingDirectory: "/workspace/project",
});

function setup(mode: ToolPermissionMode, decisions: Array<"allow-once" | "allow-session" | "deny" | "cancel"> = ["allow-once"]) {
  const execute = vi.fn(async () => ({ toolCallId: "", content: "executed" }));
  const delegate: IToolExecutor = { execute, validate: vi.fn(() => true) };
  const requestApproval = vi.fn(async () => decisions.shift() ?? "allow-once");
  const gate = new ToolPermissionGate({ resolveMode: () => mode, requestApproval });
  return { executor: new PermissionAwareToolExecutor(delegate, gate), gate, execute, requestApproval };
}

describe("tool permissions", () => {
  it("defaults missing and invalid modes to full access", () => {
    expect(normalizeToolPermissionMode(undefined)).toBe("full-access");
    expect(normalizeToolPermissionMode("invalid")).toBe("full-access");
  });

  it("never prompts in full access mode", async () => {
    const { executor, execute, requestApproval } = setup("full-access");
    await executor.execute("bash", { command: "rm -rf build" }, ctx());
    expect(execute).toHaveBeenCalledOnce();
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("always prompts for shell and internet access in request approval mode", async () => {
    const { executor, requestApproval } = setup("request-approval", ["allow-once", "allow-once"]);
    await executor.execute("bash", { command: "bun test" }, ctx());
    await executor.execute("web_fetch", { url: "https://example.com" }, ctx());
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it("allows safe reads, workspace edits, tests and builds in auto approval mode", async () => {
    const { executor, execute, requestApproval } = setup("auto-approval");
    await executor.execute("read_file", { file_path: "README.md" }, ctx());
    await executor.execute("write_file", { file_path: "src/new.ts" }, ctx());
    await executor.execute("bash", { command: "bun test && bun run build" }, ctx());
    expect(execute).toHaveBeenCalledTimes(3);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("prompts for risky, external and unknown operations in auto approval mode", async () => {
    const { executor, requestApproval } = setup("auto-approval", ["allow-once", "allow-once", "allow-once", "allow-once"]);
    await executor.execute("bash", { command: "git push origin feature" }, ctx());
    await executor.execute("bash", { command: "echo result > /tmp/out.txt" }, ctx());
    await executor.execute("write_file", { file_path: "/tmp/out.txt" }, ctx());
    await executor.execute("custom_tool", {}, ctx());
    expect(requestApproval).toHaveBeenCalledTimes(4);
  });

  it("does not execute after deny and cancels the turn after cancel", async () => {
    const { executor, execute } = setup("request-approval", ["deny", "cancel"]);
    const denied = await executor.execute("bash", { command: "pwd" }, ctx());
    expect(denied.isError).toBe(true);
    await expect(executor.execute("web_search", { query: "test" }, ctx())).rejects.toThrow("turn_aborted");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not prompt or execute when the turn was already aborted", async () => {
    const { executor, execute, requestApproval } = setup("request-approval");
    const controller = new AbortController();
    controller.abort();
    await expect(executor.execute("bash", { command: "pwd" }, {
      ...ctx(),
      signal: controller.signal,
    })).rejects.toThrow("turn_aborted");
    expect(requestApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps allow-for-session approvals isolated by session and resource", async () => {
    const { executor, requestApproval } = setup("request-approval", ["allow-session", "allow-once", "allow-once"]);
    await executor.execute("bash", { command: "bun test" }, ctx("session-a"));
    await executor.execute("bash", { command: "bun test" }, ctx("session-a"));
    await executor.execute("bash", { command: "bun run build" }, ctx("session-a"));
    await executor.execute("bash", { command: "bun test" }, ctx("session-b"));
    expect(requestApproval).toHaveBeenCalledTimes(3);
  });

  it("classifies workspace and external patches separately", () => {
    expect(classifyToolPermission("apply_patch", { patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@" }, "/workspace/project").kind)
      .toBe("workspace-write");
    expect(classifyToolPermission("apply_patch", { patch: "--- /tmp/a.ts\n+++ /tmp/a.ts\n@@ -1 +1 @@" }, "/workspace/project").kind)
      .toBe("external-write");
  });
});
