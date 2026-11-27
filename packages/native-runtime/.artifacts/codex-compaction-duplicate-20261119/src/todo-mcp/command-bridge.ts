import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { NativeTodoMcpConfiguration } from "../agent-runtime/runtime-tool-injection";
import { TodoServiceClient, type TodoClientOptions } from "./todo-service-client";
import { TODO_TOOLS, todoToolOperation } from "./tool-definitions";

type TodoCaller = Pick<TodoServiceClient, "call">;
type ClientFactory = (options: TodoClientOptions) => TodoCaller;
const createClient: ClientFactory = options => new TodoServiceClient(options);
const PROMPT_PREFIX = "[AGENTROAM_INTERNAL_TODO_COMMAND_BRIDGE_V1:";
const PROMPT_END = "\n[/AGENTROAM_INTERNAL_TODO_COMMAND_BRIDGE_V1]\n";
const INSTRUCTION_TITLE = "AgentRoam personal Todo command bridge (not native MCP registration).";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Todo bridge expects a JSON object");
  return value as Record<string, unknown>;
}

function toolsForScope(scope: string) {
  if (scope !== "manage" && scope !== "execution") throw new Error("Runtime relay credentials cannot provide Todo tools");
  return TODO_TOOLS.filter(tool => scope === "execution"
    ? ["todo_get", "todo_report_execution"].includes(tool.name)
    : tool.name !== "todo_report_execution");
}

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }

function decode(value: string): unknown {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 1024 * 1024) throw new Error("Todo bridge request must be bounded base64url JSON");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

/** A one-shot bridge over the same scoped service client as the Todo MCP server.
 * Credentials stay in their descriptor file, never in command text or prompts. */
export async function runTodoCommandBridge(encodedOptions: string, encodedRequest: string, clientFactory: ClientFactory = createClient): Promise<unknown> {
  const options = object(decode(encodedOptions));
  if (typeof options.serviceId !== "string" || !options.serviceId || typeof options.descriptorPath !== "string" || !options.descriptorPath
    || (options.registry !== undefined && typeof options.registry !== "string")) throw new Error("Invalid Todo bridge service descriptor");
  const client = clientFactory({ serviceId: options.serviceId, descriptorPath: options.descriptorPath,
    ...(typeof options.registry === "string" ? { registry: options.registry } : {}) });
  const identity = await client.call("identity");
  const request = object(decode(encodedRequest));
  if (typeof request.name !== "string" || !toolsForScope(identity.scope).some(tool => tool.name === request.name)) {
    throw new Error("Todo tool is not permitted by this credential scope");
  }
  const input = object(request.input);
  const call = todoToolOperation(request.name, input);
  return client.call(call.operation, call.args);
}

export interface TodoCommandLaunch {
  executable: string;
  args: string[];
  env: Record<string, string>;
  /** The request argument uses only the base64url alphabet. */
  requestPlaceholder: string;
  command: string;
}

interface TodoCommandRuntime {
  executable: string;
  moduleUrl: string;
  platform: NodeJS.Platform;
  env?: { ELECTRON_RUN_AS_NODE?: string };
}

/** Quote each argv item for the native shell; JSON is encoded data, never shell. */
export function todoCommandLaunch(options: TodoClientOptions, runtime: TodoCommandRuntime): TodoCommandLaunch {
  if (!runtime.executable || /[\0\r\n]/.test(runtime.executable)) throw new Error("Invalid Todo bridge runtime executable");
  const encodedOptions = encode(options), encodedModule = Buffer.from(runtime.moduleUrl, "utf8").toString("base64url");
  const script = `import(Buffer.from('${encodedModule}','base64url').toString('utf8')).then(async m=>{const result=await m.runTodoCommandBridge('${encodedOptions}',process.argv[1]);process.stdout.write(JSON.stringify(result)+'\\n')}).catch(e=>{console.error(e.message);process.exitCode=1})`;
  const args = ["--input-type=module", "-e", script];
  const quote = runtime.platform === "win32"
    ? (value: string) => `'${value.replaceAll("'", "''")}'`
    : (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const requestPlaceholder = "REQUEST_BASE64URL";
  const env: Record<string, string> = {};
  if (runtime.env?.ELECTRON_RUN_AS_NODE !== undefined) {
    if (runtime.env.ELECTRON_RUN_AS_NODE !== "1") throw new Error("Invalid Electron Node launch environment");
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  const invocation = `${runtime.platform === "win32" ? "& " : ""}${[runtime.executable, ...args, requestPlaceholder].map(quote).join(" ")}`;
  const command = !env.ELECTRON_RUN_AS_NODE ? invocation : runtime.platform === "win32"
    ? `& { $agentroamTodoPreviousElectron = $env:ELECTRON_RUN_AS_NODE; try { $env:ELECTRON_RUN_AS_NODE = '1'; ${invocation}; $agentroamTodoExitCode = $LASTEXITCODE } finally { if ($null -eq $agentroamTodoPreviousElectron) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } else { $env:ELECTRON_RUN_AS_NODE = $agentroamTodoPreviousElectron } }; if ($agentroamTodoExitCode -ne 0) { throw \"Todo bridge failed (exit code $agentroamTodoExitCode)\" } }`
    : `env ${quote("ELECTRON_RUN_AS_NODE=1")} ${invocation}`;
  return { executable: runtime.executable, args, env, requestPlaceholder, command };
}

export interface TodoPromptBridge { wrap(input: string): string }

/** Host sessions have no supported MCP mount operation. This uses their existing
 * terminal tool and preserves the Host's session and writer ownership. */
export async function prepareTodoCommandBridge(configuration: NativeTodoMcpConfiguration, dependencies: {
  clientFactory?: ClientFactory;
  runtime?: TodoCommandRuntime;
} = {}): Promise<TodoPromptBridge> {
  const descriptorPath = configuration.env.AGENTROAM_TODO_DESCRIPTOR;
  if (!descriptorPath) throw new Error("A scoped Todo credential descriptor is required for the command bridge");
  const descriptor = object(JSON.parse(await readFile(descriptorPath, "utf8")));
  if (typeof descriptor.serviceId !== "string" || !descriptor.serviceId) throw new Error("Todo descriptor has no service identity");
  const options: TodoClientOptions = { serviceId: descriptor.serviceId, descriptorPath,
    ...(configuration.env.AGENTROAM_DISCOVERY_DIR ? { registry: configuration.env.AGENTROAM_DISCOVERY_DIR } : {}) };
  const identity = await (dependencies.clientFactory ?? createClient)(options).call("identity");
  const tools = toolsForScope(identity.scope);
  const runtime = dependencies.runtime ?? { executable: configuration.command,
    moduleUrl: pathToFileURL(createRequire(import.meta.url).resolve("@agent/native-runtime")).href, platform: process.platform,
    ...(configuration.env.ELECTRON_RUN_AS_NODE ? { env: { ELECTRON_RUN_AS_NODE: configuration.env.ELECTRON_RUN_AS_NODE } } : {}) };
  const launch = todoCommandLaunch(options, runtime);
  const example = encode({ name: tools.some(tool => tool.name === "todo_list") ? "todo_list" : "todo_get",
    input: tools.some(tool => tool.name === "todo_list") ? {} : { taskId: "CURRENT_TASK_ID" } });
  const instructions = [INSTRUCTION_TITLE,
    "Use the current native terminal tool to invoke this scoped local bridge. It reads/writes the same owner's AgentRoam personal Todos visible in Calendar. It does not add a native MCP tool to the Harness tool list.",
    "These are persistent personal Todos, distinct from Wiki threads and temporary conversation plans. Never claim creation without a successful returned task ID. Unscheduled Todos appear in Calendar's unscheduled area. A blocked/unavailable terminal or failed command means the Todo operation failed; report that explicitly and do not silently use another store.",
    "For each call, encode UTF-8 JSON {\"name\":\"todo_tool_name\",\"input\":{...}} as base64url. Replace REQUEST_BASE64URL with that single argument (letters, digits, underscore, hyphen only). Never put raw user text, JSON, credentials or shell expressions into the command. Execute it with the native shell shown below and inspect JSON stdout plus exit status. Use a stable requestId for each write; a retry of the same write must reuse that ID. Read todo_get for expectedVersion before updating.",
    `Native shell: ${runtime.platform === "win32" ? "PowerShell" : "POSIX shell"}. Command template:\n${launch.command}`,
    `Read-only request encoding example: ${example}${identity.scope === "execution" ? " (replace CURRENT_TASK_ID with the current execution's task ID before encoding)" : ""}`,
    `Only these tools are available to this credential (${identity.scope}):\n${JSON.stringify(tools)}`,
  ].join("\n\n");
  return { wrap(input) { return `${PROMPT_PREFIX}${instructions.length}]\n${instructions}${PROMPT_END}${input}`; } };
}

/** Strip only the exact complete internal envelope; malformed/user text survives. */
export function stripTodoCommandBridgeInstructions(input: string): string {
  if (!input.startsWith(PROMPT_PREFIX)) return input;
  const end = input.indexOf("]\n", PROMPT_PREFIX.length);
  if (end < 0) return input;
  const lengthText = input.slice(PROMPT_PREFIX.length, end);
  if (!/^\d{1,7}$/.test(lengthText)) return input;
  const start = end + 2, size = Number(lengthText);
  const instructions = input.slice(start, start + size);
  if (!instructions.startsWith(INSTRUCTION_TITLE) || input.slice(start + size, start + size + PROMPT_END.length) !== PROMPT_END) return input;
  return input.slice(start + size + PROMPT_END.length);
}
