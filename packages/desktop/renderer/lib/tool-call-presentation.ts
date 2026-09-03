const COMMAND_TOOLS = new Set(["shell", "bash", "Bash", "execute_command", "run_command", "BashOutput", "KillShell"]);
const FILE_TOOLS = new Set(["Read", "read_file", "Write", "write_file", "Edit", "MultiEdit", "str_replace", "apply_patch", "NotebookEdit"]);
const SEARCH_TOOLS = new Set(["Glob", "glob_search", "Grep", "grep_search", "WebSearch", "WebFetch"]);

export type ToolFamily = "command" | "file" | "search" | "generic";

const READ_TOOLS = new Set(["Read", "read_file"]);
const WRITE_TOOLS = new Set(["Write", "write_file", "Edit", "MultiEdit", "str_replace", "apply_patch", "NotebookEdit"]);

export function toolFamily(name: string): ToolFamily {
  if (COMMAND_TOOLS.has(name)) return "command";
  if (FILE_TOOLS.has(name)) return "file";
  if (SEARCH_TOOLS.has(name)) return "search";
  return "generic";
}

export function toolPhrase(name: string): { done: string; doing: string } | null {
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
    case "WebSearch":
      return { done: "搜索了网络", doing: "搜索网络中" };
    case "WebFetch":
      return { done: "读取了网页", doing: "读取网页中" };
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

export function toolActivityLabel(name: string): string | null {
  if (COMMAND_TOOLS.has(name)) return "终端";
  if (READ_TOOLS.has(name)) return "查阅";
  if (WRITE_TOOLS.has(name)) return "写入";
  if (SEARCH_TOOLS.has(name)) return "查阅";
  if (name === "Skill") return "技能";
  if (name === "Task" || name === "dispatch_agent" || name === "Agent") return "子任务";
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

export function toolPreview(name: string, args: Record<string, unknown>): string | null {
  if (COMMAND_TOOLS.has(name)) return truncateLine(String(args.command ?? ""));
  if (name === "apply_patch") {
    const changes = Array.isArray(args.changes) ? args.changes as Array<Record<string, unknown>> : [];
    const paths = changes.map((change) => basename(String(change?.path ?? ""))).filter(Boolean);
    if (!paths.length) return null;
    return paths.length <= 3 ? paths.join("、") : `${paths.slice(0, 3).join("、")} 等 ${paths.length} 个文件`;
  }
  if (FILE_TOOLS.has(name)) return args.file_path ? basename(String(args.file_path)) : null;
  if (name === "Glob" || name === "glob_search") return String(args.pattern ?? "") || null;
  if (name === "Grep" || name === "grep_search") return String(args.pattern ?? args.query ?? "") || null;
  if (name === "Skill") return String(args.skill ?? "") || null;
  if (name === "Task") return truncateLine(String(args.description ?? args.task ?? ""), 80) || null;
  if (name === "WebSearch") return truncateLine(String(args.query ?? ""));
  if (name === "WebFetch") return String(args.url ?? "") || null;
  if (name.startsWith("mcp__")) return name.split("__").slice(1).join("/");
  if (name.includes(":")) return name.split(":").slice(1).join(":");
  return null;
}
