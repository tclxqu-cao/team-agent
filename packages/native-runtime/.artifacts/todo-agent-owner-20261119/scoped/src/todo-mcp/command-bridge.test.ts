import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessMessage } from "../agent-runtime/deepseek-harness-codec";
import { prepareTodoCommandBridge, runTodoCommandBridge, stripTodoCommandBridgeInstructions, todoCommandLaunch } from "./command-bridge";

const exec = promisify(execFile);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const options = { serviceId: "service-1", descriptorPath: "/private/credential.json", registry: "/private/discovery" };
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function descriptor() {
  const directory = await mkdtemp(join(tmpdir(), "todo-command-bridge-"));
  directories.push(directory);
  const path = join(directory, "credential.json"), token = "synthetic-secret-never-in-prompt";
  await writeFile(path, JSON.stringify({ serviceId: "service-1", scope: "manage", token }), { mode: 0o600 });
  return { path, token };
}

describe("scoped Todo command bridge", () => {
  it("maps a management write to the existing service command without changing request identity", async () => {
    const call = vi.fn(async (operation: string, args?: unknown) => operation === "identity" ? { scope: "manage" } : { id: "todo-1", args });
    const factory = vi.fn(() => ({ call }));
    const request = { name: "todo_create", input: { title: "Review course", requestId: "stable-write-1" } };
    await expect(runTodoCommandBridge(encode(options), encode(request), factory)).resolves.toMatchObject({ id: "todo-1" });
    expect(factory).toHaveBeenCalledWith(options);
    expect(call.mock.calls).toEqual([["identity"], ["execute", { command: { type: "create", title: "Review course" }, requestId: "stable-write-1" }]]);
  });

  it("permits only get/report for execution credentials and refuses relay credentials", async () => {
    const call = vi.fn(async (operation: string) => operation === "identity" ? { scope: "execution" } : { ok: true });
    const factory = () => ({ call });
    await expect(runTodoCommandBridge(encode(options), encode({ name: "todo_get", input: { taskId: "task-1" } }), factory)).resolves.toEqual({ ok: true });
    await expect(runTodoCommandBridge(encode(options), encode({ name: "todo_report_execution", input: { requestId: "report-1", outcome: "progress", summary: "checked" } }), factory)).resolves.toEqual({ ok: true });
    call.mockClear();
    for (const name of ["todo_create", "todo_complete", "todo_list", "unknown"]) {
      await expect(runTodoCommandBridge(encode(options), encode({ name, input: {} }), factory)).rejects.toThrow("not permitted");
    }
    expect(call.mock.calls.every(([operation]) => operation === "identity")).toBe(true);
    await expect(runTodoCommandBridge(encode(options), encode({ name: "todo_report_execution", input: {} }), () => ({ call: async () => ({ scope: "manage" }) }))).rejects.toThrow("not permitted");
    await expect(runTodoCommandBridge(encode(options), encode({ name: "todo_get", input: {} }), () => ({ call: async () => ({ scope: "relay" }) }))).rejects.toThrow("relay credentials");
  });

  it("rejects shell-like payloads, unknown operations and non-object inputs before an operation", async () => {
    const call = vi.fn(async (_operation: string) => ({ scope: "manage" }));
    for (const encoded of ["$(invalid)", "abc;echo", encode({ name: "identity", input: {} }), encode({ name: "todo_create", input: [] })]) {
      await expect(runTodoCommandBridge(encode(options), encoded, () => ({ call }))).rejects.toThrow();
    }
    expect(call.mock.calls.every(([operation]) => operation === "identity")).toBe(true);
  });

  it("encodes arbitrary paths and user input as data and executes safely through a POSIX shell", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(join(tmpdir(), "todo bridge ' $() ` & ; "));
    directories.push(directory);
    const executable = join(directory, "node ' $() ` ;"), entry = join(directory, "bridge ' $() ` ;.mjs");
    await symlink(process.execPath, executable);
    await writeFile(entry, "export async function runTodoCommandBridge(options,request){return {options:JSON.parse(Buffer.from(options,'base64url').toString()),request:JSON.parse(Buffer.from(request,'base64url').toString())}}", "utf8");
    const paths = { serviceId: "service-1", descriptorPath: join(directory, "descriptor $(false) ' .json"), registry: join(directory, "registry `false`") };
    const request = { name: "todo_create", input: { title: "'; $(false) `false` & echo \\\" 中文\nnext", requestId: "write-1" } };
    const launch = todoCommandLaunch(paths, { executable, moduleUrl: pathToFileURL(entry).href, platform: process.platform });
    expect(launch.command).not.toContain(request.input.title);
    expect(launch.command).not.toContain(paths.descriptorPath);
    const result = await exec("sh", ["-c", launch.command.replace(launch.requestPlaceholder, encode(request))]);
    expect(JSON.parse(result.stdout)).toEqual({ options: paths, request });
    expect(result.stderr).toBe("");
  }, 30_000);

  it("renders Windows argv using PowerShell quoting without POSIX environment syntax", () => {
    const paths = { serviceId: "windows-service", descriptorPath: "C:\\Users\\Other Person\\Todo ' $() `;\\credential.json", registry: "D:\\AgentRoam services" };
    const launch = todoCommandLaunch(paths, { executable: "C:\\Program Files\\O'Brien $() `;\\node.exe", moduleUrl: "file:///C:/Program%20Files/AgentRoam/runtime.mjs", platform: "win32" });
    expect(launch.command).toMatch(/^& 'C:\\Program Files\\O''Brien \$\(\) `;\\node\.exe'/);
    expect(launch.args.slice(0, 2)).toEqual(["--input-type=module", "-e"]);
    expect(launch.command).not.toContain(paths.descriptorPath);
    expect(launch.command).not.toContain("AGENTROAM_TODO_DESCRIPTOR=");
    expect(launch.command.endsWith(" 'REQUEST_BASE64URL'")).toBe(true);
  });

  it("applies only the explicit Electron Node launch flag and restores PowerShell environment", () => {
    const runtime = { executable: "C:\\Program Files\\Agent's app.exe", moduleUrl: "file:///runtime/index.js", env: { ELECTRON_RUN_AS_NODE: "1" } };
    const windows = todoCommandLaunch(options, { ...runtime, platform: "win32" });
    expect(windows.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(windows.command).toContain("try { $env:ELECTRON_RUN_AS_NODE = '1'; & 'C:\\Program Files\\Agent''s app.exe'");
    expect(windows.command).toContain("finally {");
    expect(windows.command).toContain("$env:ELECTRON_RUN_AS_NODE = $agentroamTodoPreviousElectron");
    expect(windows.command).toContain("throw \"Todo bridge failed");
    const posix = todoCommandLaunch(options, { ...runtime, executable: "/Application's app/runtime", platform: "darwin" });
    expect(posix.command).toMatch(/^env 'ELECTRON_RUN_AS_NODE=1' '\/Application'\\''s app\/runtime'/);
    expect(() => todoCommandLaunch(options, { ...runtime, platform: "win32", env: { ELECTRON_RUN_AS_NODE: "1; unsafe" } })).toThrow("launch environment");
  });

  it("preflights the exact service, keeps tokens out and restores user text in native history", async () => {
    const fixture = await descriptor(), call = vi.fn(async () => ({ scope: "manage" }));
    const bridge = await prepareTodoCommandBridge({ command: process.execPath, args: [], env: { AGENTROAM_TODO_DESCRIPTOR: fixture.path, AGENTROAM_DISCOVERY_DIR: "/runtime/discovery" } }, {
      clientFactory: configuration => { expect(configuration).toEqual({ serviceId: "service-1", descriptorPath: fixture.path, registry: "/runtime/discovery" }); return { call }; },
      runtime: { executable: process.execPath, moduleUrl: "file:///runtime/index.js", platform: process.platform },
    });
    const userInput = "添加个人待办\n保留空行\n\n原文 ' $() ` 中文";
    const wrapped = bridge.wrap(userInput);
    expect(wrapped).toContain("not native MCP registration");
    expect(wrapped).toContain("todo_create");
    expect(wrapped).not.toContain(fixture.token);
    expect(stripTodoCommandBridgeInstructions(wrapped)).toBe(userInput);
    expect(harnessMessage({ type: "user/message", seq: 1, data: { role: "user", content: [{ type: "text", text: wrapped }] } })).toMatchObject({ role: "user", content: userInput });
    expect(stripTodoCommandBridgeInstructions(`${wrapped}more`)).toBe(`${userInput}more`);
    expect(stripTodoCommandBridgeInstructions(wrapped.replace("]\nAgentRoam", "]\nUnrecognized"))).not.toBe(userInput);
    expect(call).toHaveBeenCalledOnce();
  });

  it("publishes only get/report documentation to an execution scope and fails on unavailable service", async () => {
    const fixture = await descriptor();
    const configuration = { command: process.execPath, args: [], env: { AGENTROAM_TODO_DESCRIPTOR: fixture.path } };
    const dependencies = { runtime: { executable: process.execPath, moduleUrl: "file:///runtime/index.js", platform: process.platform } };
    const bridge = await prepareTodoCommandBridge(configuration, { ...dependencies, clientFactory: () => ({ call: async () => ({ scope: "execution" }) }) });
    const prompt = bridge.wrap("report current execution");
    expect(prompt).toContain("todo_get"); expect(prompt).toContain("todo_report_execution");
    expect(prompt).not.toContain("todo_create"); expect(prompt).not.toContain("todo_complete");
    await expect(prepareTodoCommandBridge(configuration, { ...dependencies, clientFactory: () => ({ call: async () => { throw new Error("Selected Todo service is unavailable"); } }) })).rejects.toThrow("unavailable");
    await expect(prepareTodoCommandBridge({ ...configuration, env: {} })).rejects.toThrow("scoped Todo credential descriptor");
  });
});
