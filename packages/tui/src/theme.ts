export interface TuiTheme {
  brand: string;
  spark: string;
  agent: string;
  user: string;
  ready: string;
  active: string;
  progress: string;
  tool: string;
  error: string;
  muted: string;
  faint: string;
  text: string;
  strong: string;
  code: string;
}

export const THEME_NAMES = ["default", "dim", "light"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];
export const DEFAULT_THEME_NAME: ThemeName = "default";

const DEFAULT_THEME: TuiTheme = {
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
};

const DIM_THEME: TuiTheme = {
  ...DEFAULT_THEME,
  brand: "#7A9E7E",
  spark: "#A8B8A0",
  agent: "#9CC4B0",
  user: "#8FAE8A",
  ready: "#8AA98A",
  active: "#9BB49A",
  progress: "#C2A878",
  tool: "#A294B8",
  muted: "#7A8272",
  faint: "#545C4E",
  text: "#C8CCBE",
  strong: "#E4E8DA",
  code: "#A3BFD4",
};

const LIGHT_THEME: TuiTheme = {
  brand: "#1A65C9",
  spark: "#7A4FC9",
  agent: "#0B6E99",
  user: "#1F7A38",
  ready: "#1F7A38",
  active: "#1A65C9",
  progress: "#9A6A00",
  tool: "#7A3FA8",
  error: "#C22F38",
  muted: "#6B7280",
  faint: "#9CA3AF",
  text: "#1F2430",
  strong: "#0B0E14",
  code: "#1A5CB8",
};

export const THEMES: Record<ThemeName, TuiTheme> = {
  default: DEFAULT_THEME,
  dim: DIM_THEME,
  light: LIGHT_THEME,
};

export const THEME_LABELS: Record<ThemeName, string> = {
  default: "默认蓝",
  dim: "暗淡绿",
  light: "浅色",
};

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && (THEME_NAMES as readonly string[]).includes(value);
}

/**
 * Shared mutable theme. Components read properties at render time, so
 * applyTheme() plus a re-render switches the whole UI without prop drilling.
 */
export const TUI_THEME: TuiTheme = { ...DEFAULT_THEME };

export function applyTheme(name: ThemeName): void {
  Object.assign(TUI_THEME, THEMES[name] ?? DEFAULT_THEME);
}

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
  permissions: "审批模式",
  themes: "主题",
  mcp: "MCP 服务",
} as const;
