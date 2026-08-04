import { create } from "zustand";
import { persist } from "zustand/middleware";

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

interface UIState {
  skin: SkinId;
  layout: LayoutId;
  /** 助手回复自动语音播报 */
  autoSpeak: boolean;
  /** 隐藏窗口后持续监听语音唤醒 */
  wakeEnabled: boolean;
  /** 唤醒词（命中即唤起窗口） */
  wakeWord: string;

  setSkin: (skin: SkinId) => void;
  setLayout: (layout: LayoutId) => void;
  setAutoSpeak: (v: boolean) => void;
  setWakeEnabled: (v: boolean) => void;
  setWakeWord: (w: string) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      skin: "pearl",
      layout: "standard",
      autoSpeak: false,
      wakeEnabled: true,
      wakeWord: "小智",

      setSkin: (skin) => set({ skin }),
      setLayout: (layout) => set({ layout }),
      setAutoSpeak: (autoSpeak) => set({ autoSpeak }),
      setWakeEnabled: (wakeEnabled) => set({ wakeEnabled }),
      setWakeWord: (wakeWord) => set({ wakeWord }),
    }),
    { name: "agent-ui-prefs" },
  ),
);
