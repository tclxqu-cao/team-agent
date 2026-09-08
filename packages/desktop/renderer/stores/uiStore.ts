import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isBrowserRuntime } from "../web/webLayout";

export type SkinId = "pearl" | "scifi" | "noir";
export type LayoutId = "standard" | "focus" | "compact";

export interface SkinMeta {
  id: SkinId;
  label: string;
  preview: [string, string]; // [bg, accent] for swatch
}

export interface LayoutMeta {
  id: LayoutId;
  label: string;
  description: string;
}

export const SKINS: SkinMeta[] = [
  { id: "pearl", label: "珍珠白", preview: ["#f5f6fa", "#4f6ef7"] },
  { id: "scifi", label: "科幻霓虹", preview: ["#050a14", "#22d3ee"] },
  { id: "noir", label: "暗夜黑", preview: ["#0f1115", "#a78bfa"] },
];

export const LAYOUTS: LayoutMeta[] = [
  { id: "standard", label: "标准", description: "侧边栏 + 对话区" },
  { id: "focus", label: "专注", description: "隐藏侧边栏，居中沉浸对话" },
  { id: "compact", label: "紧凑", description: "更小间距与字号，信息密度优先" },
];

export interface UIState {
  skin: SkinId;
  layout: LayoutId;
  /** 助手回复自动语音播报 */
  autoSpeak: boolean;
  /** 隐藏窗口后持续监听语音唤醒 */
  wakeEnabled: boolean;
  /** 唤醒词（命中即唤起窗口） */
  wakeWord: string;
  /** 侧边栏将进行中的会话排在最前 */
  runningFirst: boolean;
  /** 侧边栏置顶的根会话 ID */
  pinnedSessionIds: string[];

  setSkin: (skin: SkinId) => void;
  setLayout: (layout: LayoutId) => void;
  setAutoSpeak: (v: boolean) => void;
  setWakeEnabled: (v: boolean) => void;
  setWakeWord: (w: string) => void;
  setRunningFirst: (v: boolean) => void;
  togglePinnedSession: (id: string) => void;
  removePinnedSessions: (ids: readonly string[]) => void;
}

const UI_PREFERENCES_VERSION = 4;

export function normalizePinnedSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

export function migrateUIPreferences(persisted: unknown, version: number): Partial<UIState> {
  const preferences = (persisted ?? {}) as Partial<UIState>;
  return {
    ...(preferences.skin !== undefined ? { skin: preferences.skin } : {}),
    ...(preferences.layout !== undefined ? { layout: preferences.layout } : {}),
    ...(preferences.autoSpeak !== undefined ? { autoSpeak: preferences.autoSpeak } : {}),
    ...(preferences.wakeEnabled !== undefined ? { wakeEnabled: preferences.wakeEnabled } : {}),
    ...(preferences.wakeWord !== undefined ? { wakeWord: preferences.wakeWord } : {}),
    ...(preferences.runningFirst !== undefined ? { runningFirst: preferences.runningFirst } : {}),
    pinnedSessionIds: normalizePinnedSessionIds(preferences.pinnedSessionIds),
    ...(version < UI_PREFERENCES_VERSION && isBrowserRuntime() ? { wakeEnabled: false } : {}),
  };
}

/** Browser shells have no background window to wake, so they start opted out. */
export function getDefaultWakeEnabled(browserRuntime = isBrowserRuntime()): boolean {
  return !browserRuntime;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      skin: "pearl",
      layout: "standard",
      autoSpeak: false,
      wakeEnabled: getDefaultWakeEnabled(),
      wakeWord: "小智",
      runningFirst: false,
      pinnedSessionIds: [],

      setSkin: (skin) => set({ skin }),
      setLayout: (layout) => set({ layout }),
      setAutoSpeak: (autoSpeak) => set({ autoSpeak }),
      setWakeEnabled: (wakeEnabled) => set({ wakeEnabled }),
      setWakeWord: (wakeWord) => set({ wakeWord }),
      setRunningFirst: (runningFirst) => set({ runningFirst }),
      togglePinnedSession: (id) => set((state) => ({
        pinnedSessionIds: state.pinnedSessionIds.includes(id)
          ? state.pinnedSessionIds.filter((sessionId) => sessionId !== id)
          : normalizePinnedSessionIds([...state.pinnedSessionIds, id]),
      })),
      removePinnedSessions: (ids) => set((state) => {
        const removedIds = new Set(ids);
        return {
          pinnedSessionIds: state.pinnedSessionIds.filter((id) => !removedIds.has(id)),
        };
      }),
    }),
    {
      name: "agent-ui-prefs",
      version: UI_PREFERENCES_VERSION,
      migrate: migrateUIPreferences,
    },
  ),
);
