const COMMAND_TOOLS = new Set(["shell", "bash", "Bash", "execute_command", "run_command", "BashOutput", "KillShell"]);
const FILE_TOOLS = new Set(["Read", "read_file", "Write", "write_file", "Edit", "MultiEdit", "str_replace", "apply_patch", "NotebookEdit"]);
const SEARCH_TOOLS = new Set(["Glob", "glob_search", "Grep", "grep_search", "WebSearch", "WebFetch"]);

export type ToolFamily = "command" | "file" | "search" | "generic";

const READ_TOOLS = new Set(["Read", "read_file"]);
const WRITE_TOOLS = new Set(["Write", "write_file"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "str_replace", "apply_patch", "NotebookEdit"]);
const CODEX_SUBAGENT_TOOLS = new Set([
  "codex:subagentActivity", "codex:spawnAgent", "codex:sendInput", "codex:resumeAgent", "codex:closeAgent", "codex:wait",
  "codex:sendMessage", "codex:followupTask", "codex:interruptAgent", "codex:listAgents",
]);

const TOOL_ALIASES: Readonly<Record<string, string>> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  websearch: "WebSearch",
  webfetch: "WebFetch",
  exec_command: "shell",
};

export function canonicalToolName(name: string): string {
  return Object.hasOwn(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : name;
}

export function toolFamily(rawName: string): ToolFamily {
  const name = canonicalToolName(rawName);
  if (COMMAND_TOOLS.has(name)) return "command";
  if (FILE_TOOLS.has(name)) return "file";
  if (SEARCH_TOOLS.has(name)) return "search";
  return "generic";
}

export function toolPhrase(rawName: string): { done: string; doing: string } | null {
  const name = canonicalToolName(rawName);
  switch (name) {
    case "shell": case "bash": case "Bash": case "execute_command": case "run_command":
      return { done: "运行了命令", doing: "运行命令中" };
    case "BashOutput": case "KillShell":
      return { done: "查看了命令输出", doing: "查看输出中" };
    case "Read": case "read_file":
      return { done: "读取了文件", doing: "读取文件中" };
    case "Write": case "write_file":
      return { done: "写入了文件", doing: "写入文件中" };
    case "Edit": case "MultiEdit": case "str_replace": case "apply_patch":
      return { done: "修改了文件", doing: "修改文件中" };
    case "Glob": case "glob_search":
      return { done: "搜索了文件", doing: "搜索文件中" };
    case "Grep": case "grep_search":
      return { done: "搜索了内容", doing: "搜索内容中" };
    case "Skill":
      return { done: "调用了技能", doing: "调用技能中" };
    case "Task":
      return { done: "启动了子任务", doing: "启动子任务中" };
    case "codex:spawnAgent":
      return { done: "启动了子任务", doing: "启动子任务中" };
    case "codex:sendInput":
    case "codex:sendMessage":
      return { done: "向子任务发送了消息", doing: "向子任务发送消息中" };
    case "codex:followupTask":
      return { done: "追加了子任务", doing: "追加子任务中" };
    case "codex:resumeAgent":
      return { done: "恢复了子任务", doing: "恢复子任务中" };
    case "codex:closeAgent":
    case "codex:interruptAgent":
      return { done: "停止了子任务", doing: "停止子任务中" };
    case "codex:wait":
      return { done: "等待了子任务", doing: "等待子任务中" };
    case "codex:subagentActivity":
      return { done: "更新了子任务状态", doing: "更新子任务状态中" };
    case "codex:listAgents":
      return { done: "查看了子任务", doing: "查看子任务中" };
    case "WebSearch":
      return { done: "搜索了网络", doing: "搜索网络中" };
    case "WebFetch":
      return { done: "读取了网页", doing: "读取网页中" };
    case "view_image":
      return { done: "查看了图像", doing: "查看图像中" };
    case "TodoWrite":
      return { done: "更新了任务清单", doing: "更新任务清单中" };
    case "NotebookEdit":
      return { done: "编辑了 Notebook", doing: "编辑 Notebook 中" };
    default:
      if (name.startsWith("mcp__") || name.includes(":")) return { done: "调用了工具", doing: "调用工具中" };
      return null;
  }
}

export function toolCallActionKey(name: string): string | null {
  return toolPhrase(name)?.done ?? null;
}

export function toolActivityLabel(rawName: string): string | null {
  const name = canonicalToolName(rawName);
  if (COMMAND_TOOLS.has(name)) return "终端";
  if (READ_TOOLS.has(name)) return "查阅";
  if (WRITE_TOOLS.has(name)) return "写入";
  if (EDIT_TOOLS.has(name)) return "编辑";
  if (SEARCH_TOOLS.has(name)) return "查阅";
  if (name === "Skill") return "技能";
  if (name === "Task" || name === "dispatch_agent" || name === "Agent" || CODEX_SUBAGENT_TOOLS.has(name)) return "子任务";
  if (name === "TodoWrite") return "任务";
  if (name.startsWith("mcp__") || name.includes(":")) return "工具";
  return null;
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function truncateLine(value: string, max = 60): string {
  const first = (value ?? "").split("\n")[0].trim();
  return first.length > max ? first.slice(0, max) + "…" : first;
}

export function toolPreview(rawName: string, args: Record<string, unknown>): string | null {
  const name = canonicalToolName(rawName);
  if (COMMAND_TOOLS.has(name)) return truncateLine(String(args.command ?? args.cmd ?? ""));
  if (name === "apply_patch") {
    const changes = Array.isArray(args.changes) ? args.changes as Array<Record<string, unknown>> : [];
    const paths = changes.map((change) => basename(String(change?.path ?? ""))).filter(Boolean);
    const fileCount = (args.fileChangeSummary as { fileCount?: number } | undefined)?.fileCount ?? paths.length;
    if (!paths.length) return fileCount ? `${fileCount} 个文件` : null;
    return fileCount <= 3 ? paths.join("、") : `${paths.slice(0, 3).join("、")} 等 ${fileCount} 个文件`;
  }
  if (FILE_TOOLS.has(name) || name === "view_image") {
    const path = args.file_path ?? args.filePath ?? args.path ?? args.notebook_path;
    return path ? basename(String(path)) : null;
  }
  if (name === "Glob" || name === "glob_search") return String(args.pattern ?? "") || null;
  if (name === "Grep" || name === "grep_search") return String(args.pattern ?? args.query ?? "") || null;
  if (name === "Skill") return String(args.skill ?? "") || null;
  if (name === "Task") return truncateLine(String(args.description ?? args.task ?? ""), 80) || null;
  if (CODEX_SUBAGENT_TOOLS.has(name)) {
    const agent = typeof args.agentPath === "string" ? basename(args.agentPath) : "";
    if (name === "codex:subagentActivity") {
      const state = args.kind === "started" ? "开始工作" : args.kind === "interacted" ? "已交互"
        : args.kind === "completed" ? "已完成" : args.kind === "interrupted" ? "已中断" : "";
      return [agent, state].filter(Boolean).join(" · ") || null;
    }
    return agent || (typeof args.prompt === "string" ? truncateLine(args.prompt, 80) : null) || null;
  }
  if (name === "WebSearch") return truncateLine(String(args.query ?? ""));
  if (name === "WebFetch") return String(args.url ?? "") || null;
  if (name.startsWith("mcp__")) return name.split("__").slice(1).join("/");
  if (name.includes(":")) return name.split(":").slice(1).join(":");
  return null;
}

export function toolActivityPreview(name: string, args: Record<string, unknown>): string {
  if (toolFamily(name) === "command") return truncateLine(String(args.command ?? args.cmd ?? name), 240);
  const preview = toolPreview(name, args);
  if (!preview) return name;
  const canonical = canonicalToolName(name);
  if (READ_TOOLS.has(canonical)) return `已读取 ${preview}`;
  if (WRITE_TOOLS.has(canonical)) return `已写入 ${preview}`;
  if (EDIT_TOOLS.has(canonical)) return `已修改 ${preview}`;
  if (canonical === "Glob" || canonical === "glob_search") return `已搜索文件 ${preview}`;
  if (canonical === "Grep" || canonical === "grep_search") return `已搜索“${preview}”`;
  return preview;
}
