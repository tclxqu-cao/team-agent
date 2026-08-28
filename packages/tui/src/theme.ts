export const TUI_THEME = {
  agent: "cyan",
  user: "green",
  ready: "green",
  active: "cyan",
  progress: "yellow",
  tool: "magenta",
  error: "red",
  muted: "gray",
  text: "white",
} as const;

export const ROLE_LABELS = {
  user: "YOU",
  assistant: "AGENT",
  tool: "TOOL",
  result: "RESULT",
  notice: "INFO",
  error: "ERROR",
} as const;

export const PALETTE_TITLES = {
  slash: "命令与技能",
  mention: "项目与文件",
  models: "模型",
  sessions: "会话",
  projects: "项目",
  skills: "技能",
} as const;
