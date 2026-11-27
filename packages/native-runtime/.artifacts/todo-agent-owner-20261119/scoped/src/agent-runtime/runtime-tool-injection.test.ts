import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ entry: "" }));
vi.mock("node:module", async importOriginal => ({
  ...await importOriginal<typeof import("node:module")>(),
  createRequire: () => ({ resolve: () => state.entry }),
}));
import { nativeTodoMcpConfiguration } from "./runtime-tool-injection";

const context = {
  serviceId: "service-'\"-$(echo unintended)-中文",
  ownerId: "owner",
  descriptorPath: "C:\\Users\\Other User\\Agent Data\\todo.json",
  discoveryDirectory: "D:\\Agent Data\\services",
};
afterEach(() => vi.unstubAllEnvs());

describe("portable Todo MCP launcher", () => {
  it("executes argv safely from a module path containing spaces and quotes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentroam todo-'"));
    try {
      state.entry = join(directory, "todo module.mjs");
      await writeFile(state.entry, "export async function runTodoMcpStdio(options) { console.log(JSON.stringify({options, descriptor: process.env.AGENTROAM_TODO_DESCRIPTOR, registry: process.env.AGENTROAM_DISCOVERY_DIR})) }\n");
      vi.stubEnv("AGENT_NATIVE_NODE_BIN", process.execPath);
      const config = nativeTodoMcpConfiguration(context);
      const { stdout } = await promisify(execFile)(config.command, config.args, { env: { ...process.env, ...config.env }, windowsHide: true, timeout: 30000 });
      expect(JSON.parse(stdout)).toEqual({ options: { serviceId: context.serviceId }, descriptor: context.descriptorPath, registry: context.discoveryDirectory });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 45000);

  it.each(["C:\\Program Files\\Node\\node.exe", "/opt/custom runtime/node"])("preserves the selected runtime executable: %s", command => {
    state.entry = join(tmpdir(), "agent data", "runtime.mjs");
    vi.stubEnv("AGENT_NATIVE_NODE_BIN", command);
    expect(nativeTodoMcpConfiguration(context).command).toBe(command);
  });

  it("uses the current process and enables Node mode when hosted in Electron", () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, "electron");
    Object.defineProperty(process.versions, "electron", { configurable: true, value: "fixture" });
    vi.stubEnv("AGENT_NATIVE_NODE_BIN", "");
    try {
      const config = nativeTodoMcpConfiguration(context);
      expect(config.command).toBe(process.execPath);
      expect(config.env.ELECTRON_RUN_AS_NODE).toBe("1");
    } finally {
      if (original) Object.defineProperty(process.versions, "electron", original);
      else delete (process.versions as Record<string, string | undefined>).electron;
    }
  });
});
