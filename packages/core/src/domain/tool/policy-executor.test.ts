import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IToolExecutor, ToolContext, ToolNetworkAccess } from "./entities.js";
import type { ToolExecutionPolicy } from "./execution-policy.js";
import { PermissionAwareToolExecutor, ToolPermissionGate } from "./permissions.js";
import { PolicyAwareToolExecutor, parseSimpleCommand, resolvePolicyPath } from "./policy-executor.js";

const temporaryDirectories: string[] = [];

async function directory() {
  const value = await mkdtemp(join(tmpdir(), "agentroam-policy-executor-"));
  temporaryDirectories.push(value);
  return value;
}

afterEach(async () => {
  delete process.env.TOOL_POLICY_VISIBLE;
  delete process.env.TOOL_POLICY_SECRET;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function policy(root: string, overrides: Partial<ToolExecutionPolicy> = {}): ToolExecutionPolicy {
  return {
    id: "test",
    name: "Test",
    enabled: true,
    allowedTools: ["read_file", "write_file", "bash", "web_fetch", "mcp_test_read"],
    filesystem: { readRoots: [root], writeRoots: [], followSymlinks: false },
    commands: { mode: "deny", programs: [], inheritedEnvironment: [] },
    network: "deny",
    limits: { timeoutMs: 5_000, maxOutputBytes: 4_096 },
    ...overrides,
  };
}

function delegate(options: { network?: Record<string, ToolNetworkAccess> } = {}) {
  const execute = vi.fn<IToolExecutor["execute"]>(async (_name, args) => ({
    toolCallId: "",
    content: JSON.stringify(args),
  }));
  const value: IToolExecutor = {
    execute,
    validate: () => true,
    getNetworkAccess: (name) => options.network?.[name] ?? "none",
  };
  return { value, execute };
}

function context(root: string): ToolContext {
  return { workingDirectory: root, sessionId: "session" };
}

describe("resolvePolicyPath", () => {
  it("allows canonical in-root reads and rejects traversal", async () => {
    const root = await directory();
    await writeFile(join(root, "ok.txt"), "ok");
    await expect(resolvePolicyPath("ok.txt", root, [root], "read", false))
      .resolves.toBe(await realpath(join(root, "ok.txt")));
    await expect(resolvePolicyPath("../outside.txt", root, [root], "read", false))
      .rejects.toThrow();
  });

  it("rejects a symlink escape and missing write roots", async () => {
    const root = await directory();
    const outside = await directory();
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "link"));
    await expect(resolvePolicyPath("link/secret.txt", root, [root], "read", false))
      .rejects.toThrow("outside");
    await expect(resolvePolicyPath("new.txt", root, [], "write", false))
      .rejects.toThrow("denied");
  });
});

describe("parseSimpleCommand", () => {
  it("parses quoted arguments", () => {
    expect(parseSimpleCommand("printf '%s value' hello\\ world"))
      .toEqual(["printf", "%s value", "hello world"]);
  });

  it.each(["echo hi | cat", "echo > out", "echo $(pwd)", "FOO=x echo hi", "bash -lc pwd"])(
    "rejects shell syntax or nested execution: %s",
    (command) => {
      if (command.startsWith("bash")) {
        expect(parseSimpleCommand(command)).toEqual(["bash", "-lc", "pwd"]);
      } else {
        expect(() => parseSimpleCommand(command)).toThrow();
      }
    },
  );
});

describe("PolicyAwareToolExecutor", () => {
  it("guards read paths and denies writes before delegation", async () => {
    const root = await directory();
    await writeFile(join(root, "ok.txt"), "ok");
    const stub = delegate();
    const executor = new PolicyAwareToolExecutor(stub.value, policy(root));
    const result = await executor.execute("read_file", { file_path: "ok.txt" }, context(root));
    expect(result.isError).not.toBe(true);
    expect(stub.execute).toHaveBeenCalledWith(
      "read_file",
      { file_path: await realpath(join(root, "ok.txt")) },
      context(root),
    );
    const denied = await executor.execute("write_file", { file_path: "new.txt", content: "x" }, context(root));
    expect(denied).toMatchObject({ isError: true });
    expect(denied.content).toContain("TOOL_POLICY_DENIED");
  });

  it("denies tools and networks outside policy", async () => {
    const root = await directory();
    const stub = delegate({ network: { web_fetch: "read" } });
    const executor = new PolicyAwareToolExecutor(stub.value, policy(root));
    expect(await executor.execute("other", {}, context(root))).toMatchObject({ isError: true });
    expect(await executor.execute("web_fetch", { url: "https://example.com" }, context(root))).toMatchObject({ isError: true });
    expect(await executor.execute("mcp_test_read", {}, context(root))).toMatchObject({ isError: true });
    expect(stub.execute).not.toHaveBeenCalled();
  });

  it("runs an allowlisted executable without a shell and with a minimal environment", async () => {
    const root = await directory();
    process.env.TOOL_POLICY_VISIBLE = "yes";
    process.env.TOOL_POLICY_SECRET = "no";
    const stub = delegate();
    const executor = new PolicyAwareToolExecutor(stub.value, policy(root, {
      commands: {
        mode: "allowlist",
        programs: [{ executable: "/usr/bin/env" }],
        inheritedEnvironment: ["TOOL_POLICY_VISIBLE"],
      },
    }));
    const result = await executor.execute("bash", { command: "/usr/bin/env" }, context(root));
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("TOOL_POLICY_VISIBLE=yes");
    expect(result.content).not.toContain("TOOL_POLICY_SECRET");
    expect(stub.execute).not.toHaveBeenCalled();
  });

  it("enforces command flags, paths, timeout, and output limits", async () => {
    const root = await directory();
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "file.txt"), "ok");
    const stub = delegate();
    const commandPolicy = policy(root, {
      commands: {
        mode: "allowlist",
        programs: [
          { executable: "/bin/cat", allowedFlags: [], positionalPathIndexes: [0] },
          { executable: "/bin/sleep" },
          { executable: "/usr/bin/printf" },
        ],
        inheritedEnvironment: [],
      },
      limits: { timeoutMs: 100, maxOutputBytes: 1_024 },
    });
    const executor = new PolicyAwareToolExecutor(stub.value, commandPolicy);
    expect((await executor.execute("bash", { command: "cat docs/file.txt" }, context(root))).content).toBe("ok");
    expect(await executor.execute("bash", { command: "cat -n docs/file.txt" }, context(root))).toMatchObject({ isError: true });
    expect((await executor.execute("bash", { command: "sleep 1" }, context(root))).content).toContain("timed out");
    const output = await executor.execute("bash", { command: `printf '${"x".repeat(1_200)}'` }, context(root));
    expect(output.content).toContain("output truncated");
  });

  it("does not reach the approval gate when policy denies", async () => {
    const root = await directory();
    const requestApproval = vi.fn(async () => "allow-once" as const);
    const gate = new ToolPermissionGate({ resolveMode: () => "request-approval", requestApproval });
    const stub = delegate();
    const approved = new PermissionAwareToolExecutor(stub.value, gate);
    const executor = new PolicyAwareToolExecutor(approved, policy(root));
    await executor.execute("bash", { command: "echo denied" }, context(root));
    expect(requestApproval).not.toHaveBeenCalled();
    expect(stub.execute).not.toHaveBeenCalled();
  });
});
