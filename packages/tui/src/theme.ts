export const TUI_THEME = {
  brand: "#8AB4F8",
  spark: "#C4B5FD",
  agent: "#7DD3FC",
  user: "#86D39A",
  ready: "#78C98D",
  active: "#8AB4F8",
  progress: "#E9BD5D",
  tool: "#C6A0E8",
  error: "#F07178",
  muted: "#8995A5",
  faint: "#4D5968",
  text: "#DCE3EC",
  strong: "#F6F8FB",
  code: "#A8C7FA",
} as const;

export const ROLE_GLYPHS = {
  user: "›",
  assistant: "◆",
  tool: "⚙",
  result: "↳",
  notice: "i",
  error: "!",
  progress: "●",
  queue: "≡",
  setup: "◇",
} as const;

export const PALETTE_TITLES = {
  slash: "命令与技能",
  mention: "项目与文件",
  models: "模型",
  sessions: "会话",
  projects: "项目",
  skills: "技能",
} as const;
