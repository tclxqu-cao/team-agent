import type { ITheme } from "@xterm/xterm";

// The web shell shares the desktop renderer's three-skin system
// (packages/desktop/renderer/stores/uiStore SKINS) so one choice themes the
// tab bar, terminal, file tree and the embedded webapp UI together.
export type WebThemeId = "pearl" | "scifi" | "noir";

export interface WebTheme {
  id: WebThemeId;
  label: string;
  swatch: string;
  preview: [string, string]; // [bg, accent] for the picker swatch gradient
  /** CSS custom properties for the shell UI */
  cssVars: Record<string, string>;
  xterm: ITheme;
  termHostBg: string;
  keybar: {
    bg: string;
    border: string;
    keyBg: string;
    keyBorder: string;
    keyText: string;
    accent: string;
    accentText: string;
    drag: string;
  };
}

const base = (theme: WebTheme): WebTheme => theme;

export const WEB_THEMES: WebTheme[] = [
  base({
    id: "pearl",
    label: "珍珠白",
    swatch: "#f5f6fa",
    preview: ["#f5f6fa", "#4f6ef7"],
    cssVars: {
      "--ui-color-scheme": "light",
      "--ui-root-bg": "#f5f6fa",
      "--ui-text": "#111827",
      "--ui-tabbar-bg": "#eef0f6",
      "--ui-tabbar-border": "#dfe3ee",
      "--ui-tab-bg": "#e6e9f4",
      "--ui-tab-text": "#5b6472",
      "--ui-tab-active-bg": "#ffffff",
      "--ui-tab-active-text": "#111827",
      "--ui-tab-accent": "#4f6ef7",
      "--ui-connection-bg": "#eef0f6",
      "--ui-connection-text": "#9ca3af",
      "--ui-tree-bg": "#fbfcfe",
      "--ui-tree-border": "#e5e8f0",
      "--ui-term-col-bg": "#f5f6fa",
      "--ui-fab-bg": "#ffffff",
      "--ui-fab-border": "#d8dcea",
      "--ui-muted-surface": "#eef0f6",
      "--ui-muted-border": "#d8dcea",
      "--ui-muted-text": "#6b7280",
      "--ui-panel-input-bg": "#ffffff",
      "--ui-panel-input-text": "#111827",
      "--ui-panel-input-border": "#d8dcea",
      "--ui-drawer-tab-text": "#6b7280",
      "--ui-drawer-tab-active": "#111827",
      "--ui-history-item-text": "#1f2937",
      "--ui-history-meta": "#9ca3af",
      "--ui-success": "#059669",
      "--ui-error": "#dc2626",
    },
    termHostBg: "#ffffff",
    keybar: {
      bg: "#eef0f6",
      border: "#dfe3ee",
      keyBg: "#ffffff",
      keyBorder: "#d8dcea",
      keyText: "#4b5563",
      accent: "#4f6ef7",
      accentText: "#ffffff",
      drag: "#a5b4fc",
    },
    xterm: {
      background: "#ffffff",
      foreground: "#1f2937",
      cursor: "#4f6ef7",
      selectionBackground: "#c7d2fe",
      black: "#24292e",
      red: "#d73a49",
      green: "#22863a",
      yellow: "#b08800",
      blue: "#005cc5",
      magenta: "#6f42c1",
      cyan: "#1b7c83",
      white: "#6a737d",
      brightBlack: "#959da5",
      brightWhite: "#fafbfc",
    },
  }),
  base({
    id: "scifi",
    label: "科幻霓虹",
    swatch: "#050a14",
    preview: ["#050a14", "#22d3ee"],
    cssVars: {
      "--ui-color-scheme": "dark",
      "--ui-root-bg": "#050a14",
      "--ui-text": "#e2f3ff",
      "--ui-tabbar-bg": "#0a1220",
      "--ui-tabbar-border": "#10263c",
      "--ui-tab-bg": "#0d1626",
      "--ui-tab-text": "#5c7893",
      "--ui-tab-active-bg": "#122036",
      "--ui-tab-active-text": "#e2f3ff",
      "--ui-tab-accent": "#22d3ee",
      "--ui-connection-bg": "#0a1220",
      "--ui-connection-text": "#5c7893",
      "--ui-tree-bg": "#0d1626",
      "--ui-tree-border": "#10263c",
      "--ui-term-col-bg": "#050a14",
      "--ui-fab-bg": "#122036",
      "--ui-fab-border": "#155e75",
      "--ui-muted-surface": "#0d1626",
      "--ui-muted-border": "#164e63",
      "--ui-muted-text": "#9fb8d0",
      "--ui-panel-input-bg": "#0a1220",
      "--ui-panel-input-text": "#e2f3ff",
      "--ui-panel-input-border": "#164e63",
      "--ui-drawer-tab-text": "#5c7893",
      "--ui-drawer-tab-active": "#e2f3ff",
      "--ui-history-item-text": "#d5ecfb",
      "--ui-history-meta": "#5c7893",
      "--ui-success": "#34d399",
      "--ui-error": "#fb7185",
    },
    termHostBg: "#0a1220",
    keybar: {
      bg: "#0a1220",
      border: "#10263c",
      keyBg: "#0d1626",
      keyBorder: "#164e63",
      keyText: "#9fb8d0",
      accent: "#22d3ee",
      accentText: "#04121a",
      drag: "#155e75",
    },
    xterm: {
      background: "#0a1220",
      foreground: "#e2f3ff",
      cursor: "#22d3ee",
      selectionBackground: "#164e63",
      black: "#0d1626",
      red: "#fb7185",
      green: "#34d399",
      yellow: "#fbbf24",
      blue: "#38bdf8",
      magenta: "#e879f9",
      cyan: "#22d3ee",
      white: "#e2f3ff",
      brightBlack: "#5c7893",
      brightWhite: "#ffffff",
    },
  }),
  base({
    id: "noir",
    label: "暗夜黑",
    swatch: "#0f1115",
    preview: ["#0f1115", "#a78bfa"],
    cssVars: {
      "--ui-color-scheme": "dark",
      "--ui-root-bg": "#0f1115",
      "--ui-text": "#eceff4",
      "--ui-tabbar-bg": "#14171d",
      "--ui-tabbar-border": "#232833",
      "--ui-tab-bg": "#191d24",
      "--ui-tab-text": "#6b7280",
      "--ui-tab-active-bg": "#1f242d",
      "--ui-tab-active-text": "#eceff4",
      "--ui-tab-accent": "#a78bfa",
      "--ui-connection-bg": "#14171d",
      "--ui-connection-text": "#6b7280",
      "--ui-tree-bg": "#191d24",
      "--ui-tree-border": "#232833",
      "--ui-term-col-bg": "#0f1115",
      "--ui-fab-bg": "#1f242d",
      "--ui-fab-border": "#2a3040",
      "--ui-muted-surface": "#191d24",
      "--ui-muted-border": "#2a3040",
      "--ui-muted-text": "#aab2bf",
      "--ui-panel-input-bg": "#14171d",
      "--ui-panel-input-text": "#eceff4",
      "--ui-panel-input-border": "#2a3040",
      "--ui-drawer-tab-text": "#6b7280",
      "--ui-drawer-tab-active": "#eceff4",
      "--ui-history-item-text": "#d7dce4",
      "--ui-history-meta": "#6b7280",
      "--ui-success": "#4ade80",
      "--ui-error": "#f87171",
    },
    termHostBg: "#14171d",
    keybar: {
      bg: "#14171d",
      border: "#232833",
      keyBg: "#191d24",
      keyBorder: "#2a3040",
      keyText: "#aab2bf",
      accent: "#a78bfa",
      accentText: "#0f1115",
      drag: "#4b4470",
    },
    xterm: {
      background: "#14171d",
      foreground: "#eceff4",
      cursor: "#a78bfa",
      selectionBackground: "#3b3654",
      black: "#191d24",
      red: "#f87171",
      green: "#4ade80",
      yellow: "#fbbf24",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#67e8f9",
      white: "#eceff4",
      brightBlack: "#6b7280",
      brightWhite: "#ffffff",
    },
  }),
];

export const DEFAULT_THEME_ID: WebThemeId = "pearl";

export const WEB_THEME_MAP = Object.fromEntries(WEB_THEMES.map((theme) => [theme.id, theme])) as Record<
  WebThemeId,
  WebTheme
>;

// Legacy seven-color terminal skin ids saved in server preferences map onto
// the closest of the three unified skins.
const LEGACY_THEME_MAP: Record<string, WebThemeId> = {
  dark: "noir",
  black: "noir",
  gray: "noir",
  blue: "noir",
  red: "noir",
  yellow: "noir",
  green: "noir",
  white: "pearl",
};

export function resolveWebTheme(id: string | null | undefined): WebTheme {
  if (id && id in WEB_THEME_MAP) return WEB_THEME_MAP[id as WebThemeId];
  const legacy = id ? LEGACY_THEME_MAP[id] : undefined;
  if (legacy) return WEB_THEME_MAP[legacy];
  return WEB_THEME_MAP[DEFAULT_THEME_ID];
}
