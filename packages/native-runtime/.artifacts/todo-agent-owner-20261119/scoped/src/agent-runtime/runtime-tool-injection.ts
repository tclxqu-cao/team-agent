import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { NativeAgentType } from "@agent/core";
import { TodoServiceClient } from "../todo-mcp/todo-service-client";
export interface NativeTodoMcpConfiguration {
  command: string;
  args: string[];
  env: Record<string, string>;
  readiness?: "required" | "background";
}
export interface RuntimeTodoContext {
  serviceId: string; ownerId: string; descriptorPath: string; relayPath?: string;
  executionId?: string; model?: string;
  discoveryDirectory?: string;
}
export const TODO_NATIVE_INJECTION_SUPPORT: Record<NativeAgentType, string> = {
  "claude-code": "session", qoder: "session", workbuddy: "launch",
  codex: "session",
  opencode: "launch",
  zcode: "session", "deepseek-harness": "command-bridge", copilot: "session",
};
export function nativeTodoMcpConfiguration(
  context: RuntimeTodoContext,
  readiness: NativeTodoMcpConfiguration["readiness"] = "required",
): NativeTodoMcpConfiguration {
  const entry = createRequire(import.meta.url).resolve("@agent/native-runtime");
  const registry = context.discoveryDirectory ?? process.env.AGENTROAM_DISCOVERY_DIR;
  const command = process.env.AGENT_NATIVE_NODE_BIN?.trim() || process.execPath;
  const defer = readiness === "background" ? ",deferServiceCheck:true" : "";
  return {
    command,
    args: ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(entry).href)}).then(m=>m.runTodoMcpStdio({serviceId:${JSON.stringify(context.serviceId)}${defer}})).catch(e=>{console.error(e.message);process.exitCode=1})`],
    env: {
      AGENTROAM_TODO_DESCRIPTOR: context.descriptorPath,
      ...(registry ? { AGENTROAM_DISCOVERY_DIR: registry } : {}),
      ...(command === process.execPath && process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    ...(readiness === "background" ? { readiness } : {}),
  };
}
export async function prepareTodoInjection(context: RuntimeTodoContext, agentType: NativeAgentType) {
  const support = TODO_NATIVE_INJECTION_SUPPORT[agentType];
  if (!["session", "launch", "command-bridge"].includes(support)) return { status: "unsupported" as const, reason: support };
  if (agentType === "codex" && !context.executionId) {
    return { status: "configured" as const, configuration: nativeTodoMcpConfiguration(context, "background") };
  }
  const client = new TodoServiceClient({ serviceId: context.serviceId, descriptorPath: context.descriptorPath, registry: context.discoveryDirectory });
  await client.call("identity");
  return { status: "configured" as const, configuration: nativeTodoMcpConfiguration(context) };
}
