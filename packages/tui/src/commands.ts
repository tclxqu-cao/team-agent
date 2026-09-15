import type { SkillMeta } from "@agent/core";
import type { PaletteItem } from "./palette.js";

export interface BuiltinCommand {
  name: string;
  description: string;
  secondary?: "sessions" | "models" | "projects" | "skills" | "permissions" | "themes" | "mcp";
}

export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  { name: "/help", description: "显示命令和快捷键" },
  { name: "/new", description: "新建会话" },
  { name: "/sessions", description: "列出最近会话" },
  { name: "/open", description: "打开历史会话", secondary: "sessions" },
  { name: "/cwd", description: "显示当前工作目录" },
  { name: "/model", description: "查看或切换模型", secondary: "models" },
  { name: "/projects", description: "切换项目", secondary: "projects" },
  { name: "/skills", description: "查看已发现技能", secondary: "skills" },
  { name: "/permissions", description: "切换工具审批模式", secondary: "permissions" },
  { name: "/mcp", description: "查看/重连 MCP 服务", secondary: "mcp" },
  { name: "/theme", description: "切换配色主题", secondary: "themes" },
  { name: "/vim", description: "开关 vim 编辑模式" },
  { name: "/compact", description: "手动压缩会话上下文" },
  { name: "/image", description: "附加图片到下一条消息" },
  { name: "/undo", description: "撤销最近一轮文件修改" },
  { name: "/steer", description: "将排队消息插入当前轮" },
  { name: "/unqueue", description: "移除一条排队消息" },
  { name: "/goal", description: "目标模式：/goal 目标文本 设定，无参数查看，pause|resume|clear 控制" },
  { name: "/cost", description: "查看本会话 token 统计" },
  { name: "/clear", description: "清空当前屏幕消息" },
  { name: "/exit", description: "退出 TUI" },
];

export const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((command) => command.name));

export function createSlashItems(skills: readonly Pick<SkillMeta, "name" | "description">[]): PaletteItem[] {
  const commands = BUILTIN_COMMANDS.map((command) => ({
    id: `command:${command.name}`,
    kind: "command" as const,
    label: command.name,
    description: command.description,
    value: command.name,
  }));
  const skillItems = skills
    .filter((skill) => skill.name.trim())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => ({
      id: `skill:${skill.name}`,
      kind: "skill" as const,
      label: `/${skill.name}`,
      description: skill.description || "技能",
      value: `/${skill.name}`,
    }));
  return [...commands, ...skillItems];
}

export type SlashParseResult =
  | { type: "builtin"; name: string; args: string }
  | { type: "agent"; input: string };

export function parseSlashCommand(input: string, builtinNames = BUILTIN_NAMES): SlashParseResult {
  const trimmed = input.trim();
  const match = /^(\/\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match || !builtinNames.has(match[1])) return { type: "agent", input: trimmed };
  return { type: "builtin", name: match[1], args: match[2]?.trim() ?? "" };
}

export function helpText(): string[] {
  return [
    "输入 / 查看命令和技能，输入 @ 引用项目、文件或文件夹",
    "Alt+Enter 或行尾 \\ + Enter 换行；粘贴多行文本自动保留换行",
    "Ctrl+A/E 行首行尾 · Ctrl+K/U 删至行尾/行首 · Ctrl+W 删词 · Alt+B/F 词间跳转",
    "Ctrl+O 或 PgUp 回看历史（PgUp/PgDn 翻页，工具输出完整显示）",
    "↑/↓ 选择 · Enter 确认 · Esc 关闭候选 · Ctrl+C 中断/退出",
    ...BUILTIN_COMMANDS.map((command) => `${command.name.padEnd(15)} ${command.description}`),
  ];
}
