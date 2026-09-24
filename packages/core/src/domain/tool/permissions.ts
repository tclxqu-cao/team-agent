import { isAbsolute, relative, resolve, sep } from "node:path";
import type { IToolExecutor, ToolContext, ToolResult } from "./entities.js";

export const TOOL_PERMISSION_MODES = [
  "request-approval",
  "auto-approval",
  "full-access",
] as const;

export type ToolPermissionMode = (typeof TOOL_PERMISSION_MODES)[number];
export type ToolApprovalDecision = "allow-once" | "allow-session" | "deny" | "cancel";

export const TOOL_APPROVAL_OPTIONS = [
  { label: "允许一次", description: "仅允许当前这次工具调用" },
  { label: "本会话允许", description: "当前会话再次执行相同工具和目标时不再询问" },
  { label: "拒绝", description: "不执行这次工具调用，让 Agent 继续处理" },
  { label: "取消本轮", description: "不执行工具，并立即停止当前回复" },
] as const;

export interface ToolPermissionRequest {
  sessionId: string;
  toolName: string;
  summary: string;
  reason: string;
  resourceKey: string;
  args: Record<string, unknown>;
}

export interface ToolPermissionGateOptions {
  resolveMode(sessionId: string): ToolPermissionMode | Promise<ToolPermissionMode>;
  requestApproval(request: ToolPermissionRequest): Promise<ToolApprovalDecision>;
}

export interface ToolPermissionClassification {
  kind:
    | "safe"
    | "workspace-write"
    | "external-write"
    | "shell"
    | "network"
    | "remote"
    | "risky-local"
    | "unknown";
  risky: boolean;
  summary: string;
  reason: string;
  resourceKey: string;
}

const SAFE_TOOLS = new Set([
  "ask_user",
  "read_file",
  "grep",
  "glob",
  "show_widget",
  "todo_add",
  "todo_update",
  "todo_list",
  "wait_agent",
  "cron_list",
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
]);

const FILE_WRITE_TOOLS = new Set(["write_file", "str_replace", "apply_patch"]);
const RISKY_LOCAL_TOOLS = new Set(["cron_create", "cron_delete", "dispatch_agent"]);
const NETWORK_TOOLS = new Set(["web_fetch", "web_search"]);

const RISKY_SHELL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|[;&|]\s*)sudo\b/i, reason: "命令会以提升后的系统权限运行" },
  { pattern: /\brm\s+(?:-[^\s]*[rf][^\s]*\s+|--recursive\b|--force\b)/i, reason: "命令可能递归或强制删除文件" },
  { pattern: /\bgit\s+(?:push|clean\s+-[^\s]*f|reset\s+--hard|checkout\s+--|branch\s+-D)\b/i, reason: "命令会改变远端或丢弃本地 Git 数据" },
  { pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:publish|deploy)\b/i, reason: "命令会发布或部署产物" },
  { pattern: /\b(?:docker\s+push|kubectl\s+(?:apply|delete|replace|patch)|helm\s+(?:install|upgrade|uninstall))\b/i, reason: "命令会修改远程运行环境" },
  { pattern: /\b(?:systemctl|launchctl|shutdown|reboot|killall|pkill)\b/i, reason: "命令会改变系统进程或服务状态" },
  { pattern: /\b(?:chmod|chown)\b/i, reason: "命令会修改文件权限或所有者" },
  { pattern: /\bcurl\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)\b|--request\s+(?:POST|PUT|PATCH|DELETE)\b|(?:-d|--data(?:-raw|-binary)?)\s)/i, reason: "命令会向网络服务提交或修改数据" },
  { pattern: /\b(?:release|deploy|publish)\b/i, reason: "命令包含发布或部署操作" },
];

export function normalizeToolPermissionMode(value: unknown): ToolPermissionMode {
  return isToolPermissionMode(value)
    ? value as ToolPermissionMode
    : "full-access";
}

export function isToolPermissionMode(value: unknown): value is ToolPermissionMode {
  return typeof value === "string" && (TOOL_PERMISSION_MODES as readonly string[]).includes(value);
}

export function toolApprovalDecisionFromAnswer(
  answer: string,
  selectedIndices?: number[],
): ToolApprovalDecision {
  const index = selectedIndices?.[0] ?? TOOL_APPROVAL_OPTIONS.findIndex((option) => option.label === answer);
  return (["allow-once", "allow-session", "deny", "cancel"] as const)[index] ?? "deny";
}

function compact(value: unknown, maxLength = 140): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function isWithinWorkingDirectory(path: string, workingDirectory: string): boolean {
  const root = resolve(workingDirectory);
  const target = resolve(root, path);
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function patchPaths(patch: unknown): string[] {
  if (typeof patch !== "string") return [];
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+++ "))
    .map((line) => line.slice(4).split("\t", 1)[0].trim())
    .filter((path) => path && path !== "/dev/null")
    .map((path) => path.startsWith("b/") ? path.slice(2) : path);
}

export function writePaths(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName === "apply_patch") return patchPaths(args.patch);
  return typeof args.file_path === "string" ? [args.file_path] : [];
}

function networkResource(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "web_search") return `web-search:${compact(args.query, 80)}`;
  if (typeof args.url !== "string") return `${toolName}:network`;
  try {
    return `${toolName}:${new URL(args.url).host}`;
  } catch {
    return `${toolName}:${compact(args.url, 80)}`;
  }
}

function riskyShellReason(command: string): string | undefined {
  return RISKY_SHELL_PATTERNS.find(({ pattern }) => pattern.test(command))?.reason;
}

function externalShellWriteReason(command: string, workingDirectory: string): string | undefined {
  const redirectedPaths = Array.from(command.matchAll(/(?:^|\s)>{1,2}\s*["']?([^\s;&|><"']+)/g))
    .map((match) => match[1]);
  if (redirectedPaths.some((path) => !isWithinWorkingDirectory(path, workingDirectory))) {
    return "命令会通过重定向修改工作区外文件";
  }

  if (!/(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|touch|tee|truncate|install)\b|\bsed\b[^\n]*\s-i\b/i.test(command)) {
    return undefined;
  }
  const absolutePaths = Array.from(command.matchAll(/(?:^|\s)(\/[^\s;&|><"']+)/g))
    .map((match) => match[1]);
  return absolutePaths.some((path) => !isWithinWorkingDirectory(path, workingDirectory))
    ? "命令会修改工作区外文件"
    : undefined;
}

export function classifyToolPermission(
  toolName: string,
  args: Record<string, unknown>,
  workingDirectory: string,
): ToolPermissionClassification {
  if (SAFE_TOOLS.has(toolName)) {
    return {
      kind: "safe",
      risky: false,
      summary: `使用 ${toolName}`,
      reason: "只读取信息或更新当前会话状态",
      resourceKey: toolName,
    };
  }

  if (FILE_WRITE_TOOLS.has(toolName)) {
    const paths = writePaths(toolName, args);
    const externalPaths = paths.filter((path) => !isWithinWorkingDirectory(path, workingDirectory));
    const shownPaths = (externalPaths.length > 0 ? externalPaths : paths).map((path) => compact(path, 100));
    const keyedPaths = (externalPaths.length > 0 ? externalPaths : paths).slice().sort();
    const external = externalPaths.length > 0 || paths.length === 0;
    return {
      kind: external ? "external-write" : "workspace-write",
      risky: external,
      summary: `${external ? "修改工作区外文件" : "修改工作区文件"}${shownPaths.length ? `：${shownPaths.join("、")}` : ""}`,
      reason: external ? "目标文件不在当前工作区内" : "目标文件位于当前工作区内",
      resourceKey: `${toolName}:${keyedPaths.join("|") || "unknown-path"}`,
    };
  }

  if (toolName === "bash") {
    const rawCommand = typeof args.command === "string" ? args.command.replace(/\s+/g, " ").trim() : "";
    const command = compact(rawCommand, 240);
    const reason = riskyShellReason(rawCommand) ?? externalShellWriteReason(rawCommand, workingDirectory);
    return {
      kind: "shell",
      risky: Boolean(reason),
      summary: `运行命令：${command || "(空命令)"}`,
      reason: reason ?? "命令将在当前工作区的终端中运行",
      resourceKey: `bash:${rawCommand || "unknown-command"}`,
    };
  }

  if (NETWORK_TOOLS.has(toolName)) {
    const target = toolName === "web_search" ? compact(args.query, 100) : compact(args.url, 120);
    return {
      kind: "network",
      risky: false,
      summary: `${toolName === "web_search" ? "搜索网络" : "访问网络"}：${target || "未指定目标"}`,
      reason: "工具将连接互联网读取信息",
      resourceKey: networkResource(toolName, args),
    };
  }

  if (toolName.startsWith("mcp_")) {
    return {
      kind: "remote",
      risky: true,
      summary: `调用 MCP 工具：${toolName.slice(4)}`,
      reason: "MCP 工具可能修改外部系统，当前无法可靠判定其副作用",
      resourceKey: toolName,
    };
  }

  if (toolName === "remote_project_action") {
    const action = compact(args.action, 100) || "unknown-action";
    const readOnly = action === "remote_job_status";
    return {
      kind: readOnly ? "safe" : "remote",
      risky: !readOnly,
      summary: readOnly ? "查询远程任务状态" : `执行远程动作：${action}`,
      reason: readOnly ? "只查询已提交任务的状态" : "该动作会调用远程项目服务",
      resourceKey: `remote_project_action:${action}`,
    };
  }

  if (RISKY_LOCAL_TOOLS.has(toolName)) {
    return {
      kind: "risky-local",
      risky: true,
      summary: `执行 ${toolName}`,
      reason: toolName === "dispatch_agent" ? "子 Agent 会继续执行新的工具调用" : "该操作会改变定时任务状态",
      resourceKey: `${toolName}:${compact(args.agentName ?? args.cron ?? args.id, 100) || "default"}`,
    };
  }

  return {
    kind: "unknown",
    risky: true,
    summary: `调用未分类工具：${toolName}`,
    reason: "当前无法判断该工具是否会产生副作用",
    resourceKey: `unknown:${toolName}`,
  };
}

function requiresApproval(mode: ToolPermissionMode, classification: ToolPermissionClassification): boolean {
  if (mode === "full-access") return false;
  if (mode === "auto-approval") return classification.risky || classification.kind === "unknown";
  return ["external-write", "shell", "network", "remote", "risky-local", "unknown"].includes(classification.kind);
}

export class ToolPermissionGate {
  private readonly sessionApprovals = new Map<string, Set<string>>();
  private readonly approvalQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: ToolPermissionGateOptions) {}

  clearSession(sessionId: string): void {
    this.sessionApprovals.delete(sessionId);
  }

  async authorize(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<"allow" | "deny" | "cancel"> {
    if (ctx.signal?.aborted) return "cancel";
    const mode = normalizeToolPermissionMode(await this.options.resolveMode(ctx.sessionId));
    if (mode === "full-access") return "allow";

    const classification = classifyToolPermission(toolName, args, ctx.workingDirectory);
    if (!requiresApproval(mode, classification)) return "allow";
    if (this.sessionApprovals.get(ctx.sessionId)?.has(classification.resourceKey)) return "allow";

    return this.enqueue(ctx.sessionId, async () => {
      if (ctx.signal?.aborted) return "cancel";
      if (this.sessionApprovals.get(ctx.sessionId)?.has(classification.resourceKey)) return "allow";
      const decision = await this.options.requestApproval({
        sessionId: ctx.sessionId,
        toolName,
        summary: classification.summary,
        reason: classification.reason,
        resourceKey: classification.resourceKey,
        args,
      });
      if (ctx.signal?.aborted) return "cancel";
      if (decision === "allow-session") {
        const approvals = this.sessionApprovals.get(ctx.sessionId) ?? new Set<string>();
        approvals.add(classification.resourceKey);
        this.sessionApprovals.set(ctx.sessionId, approvals);
        return "allow";
      }
      if (decision === "allow-once") return "allow";
      return decision;
    });
  }

  private async enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.approvalQueues.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.approvalQueues.set(sessionId, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.approvalQueues.get(sessionId) === queued) this.approvalQueues.delete(sessionId);
    }
  }
}

export class PermissionAwareToolExecutor implements IToolExecutor {
  constructor(
    private readonly delegate: IToolExecutor,
    private readonly gate: ToolPermissionGate,
  ) {}

  validate(name: string, args: Record<string, unknown>): boolean {
    return this.delegate.validate(name, args);
  }

  getAuthorizationPolicy(name: string) {
    return this.delegate.getAuthorizationPolicy?.(name) ?? "default";
  }

  getNetworkAccess(name: string) {
    return this.delegate.getNetworkAccess?.(name) ?? "none";
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (this.getAuthorizationPolicy(name) === "direct") {
      return this.delegate.execute(name, args, ctx);
    }
    const decision = await this.gate.authorize(name, args, ctx);
    if (decision === "cancel") throw new Error("turn_aborted");
    if (decision === "deny") {
      return {
        toolCallId: "",
        content: `Permission denied by user: ${name}`,
        isError: true,
      };
    }
    return this.delegate.execute(name, args, ctx);
  }
}
