import { create } from "zustand";
import type { ModelProfile } from "../global.d.ts";

interface SettingsState {
  revision?: number;
  // Legacy single-model fields (reflect active profile)
  modelProvider: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  maxIterations: number;
  /** Context window in K tokens */
  contextWindow: number;
  workingDirectory: string;
  isConfigured: boolean;

  // Multi-profile
  profiles: ModelProfile[];
  activeProfileId: string;

  /** Reasoning intensity for main-loop requests ("off" = provider default) */
  reasoningEffort: "off" | "low" | "medium" | "high";

  // Actions
  setField: (key: string, value: string | number | boolean) => void;
  loadFromSystem: () => Promise<void>;
  saveToSystem: () => Promise<void>;

  // Profile management
  addProfile: (profile: Omit<ModelProfile, "id">) => void;
  updateProfile: (id: string, updates: Partial<Omit<ModelProfile, "id">>) => void;
  deleteProfile: (id: string) => void;
  setActiveProfileLocal: (id: string) => void;
  switchActiveProfile: (id: string) => Promise<void>;
}

const PERSISTED_SETTING_KEYS = [
  "modelProvider", "modelId", "apiKey", "baseUrl", "maxIterations", "contextWindow",
  "workingDirectory", "isConfigured", "profiles", "activeProfileId", "reasoningEffort",
] as const;

type PersistedSettingKey = typeof PERSISTED_SETTING_KEYS[number];
type PersistedSettings = Pick<SettingsState, PersistedSettingKey>;

let loadedSettingsSnapshot: PersistedSettings | null = null;

function persistedSettings(value: Partial<SettingsState> & Record<string, unknown>): PersistedSettings {
  return Object.fromEntries(PERSISTED_SETTING_KEYS.map((key) => [key, value[key]])) as PersistedSettings;
}

export function changedSettingsPatch(
  baseline: PersistedSettings | null,
  current: PersistedSettings,
): Partial<PersistedSettings> {
  if (!baseline) return current;
  return Object.fromEntries(PERSISTED_SETTING_KEYS
    .filter((key) => JSON.stringify(baseline[key]) !== JSON.stringify(current[key]))
    .map((key) => [key, current[key]])) as Partial<PersistedSettings>;
}

function resolveActive(profiles: ModelProfile[], id: string): ModelProfile | null {
  return profiles.find((p) => p.id === id) ?? null;
}

function profileIsConfigured(profile: Pick<ModelProfile, "provider" | "modelId" | "apiKey">): boolean {
  return profile.provider === "aihub"
    ? Boolean(profile.modelId)
    : Boolean(profile.apiKey && profile.modelId);
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  modelProvider: "anthropic",
  modelId: "claude-sonnet-4-6",
  apiKey: "",
  baseUrl: "",
  maxIterations: 10,
  contextWindow: 100,
  workingDirectory: "/",
  isConfigured: false,
  profiles: [],
  activeProfileId: "",
  reasoningEffort: "off",

  setField: (key, value) =>
    set((state) => {
      const updated = { ...state, [key]: value } as SettingsState;
      // aihub 模型来源（桌面 AI Hub 网页模型）不需要 apiKey
      updated.isConfigured = updated.modelProvider === "aihub"
        ? Boolean(updated.modelId)
        : Boolean(updated.apiKey && updated.modelId);
      return updated;
    }),

  loadFromSystem: async () => {
    if (!window.agentApi) return;
    try {
      const s = await window.agentApi.getSettings();
      const profiles = (s.profiles ?? []) as ModelProfile[];
      const activeProfileId = s.activeProfileId ?? "";
      const active = resolveActive(profiles, activeProfileId);
      const loaded = {
        revision: s.revision,
        modelProvider: active?.provider ?? s.modelProvider ?? "anthropic",
        modelId: active?.modelId ?? s.modelId ?? "claude-sonnet-4-6",
        apiKey: active?.apiKey ?? s.apiKey ?? "",
        baseUrl: active?.baseUrl ?? s.baseUrl ?? "",
        maxIterations: s.maxIterations ?? 10,
        contextWindow: s.contextWindow ?? 100,
        workingDirectory: s.workingDirectory ?? "/",
        isConfigured: (active?.provider ?? s.modelProvider) === "aihub"
          ? Boolean(active?.modelId ?? s.modelId)
          : Boolean((active?.apiKey ?? s.apiKey) && (active?.modelId ?? s.modelId)),
        profiles,
        activeProfileId,
        reasoningEffort: (["off", "low", "medium", "high"].includes(s.reasoningEffort ?? "")
          ? (s.reasoningEffort as "off" | "low" | "medium" | "high")
          : "off"),
      };
      loadedSettingsSnapshot = persistedSettings(loaded);
      set(loaded);
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  },

  saveToSystem: async () => {
    if (!window.agentApi) return;
    const state = get();
    const current = persistedSettings(state);
    const patch = changedSettingsPatch(loadedSettingsSnapshot, current);
    try {
      await window.agentApi.saveSettings({ ...patch, revision: state.revision });
    } catch (error) {
      if ((error as { status?: number })?.status !== 409) throw error;
      const latest = await window.agentApi.getSettings();
      await window.agentApi.saveSettings({ ...patch, revision: latest.revision });
    }
    await get().loadFromSystem();
  },

  addProfile: (profile) => {
    const id = crypto.randomUUID();
    const newProfile: ModelProfile = { id, ...profile };
    set((s) => ({ profiles: [...s.profiles, newProfile] }));
  },

  updateProfile: (id, updates) => {
    set((s) => ({
      profiles: s.profiles.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    }));
    const state = get();
    if (state.activeProfileId === id) {
      const updated = resolveActive(state.profiles, id);
      if (updated) {
        set({
          modelProvider: updated.provider,
          modelId: updated.modelId,
          apiKey: updated.apiKey,
          baseUrl: updated.baseUrl,
          isConfigured: profileIsConfigured(updated),
        });
      }
    }
  },

  deleteProfile: (id) => {
    set((s) => {
      const profiles = s.profiles.filter((p) => p.id !== id);
      const activeProfileId = s.activeProfileId === id ? (profiles[0]?.id ?? "") : s.activeProfileId;
      const active = resolveActive(profiles, activeProfileId);
      return {
        profiles,
        activeProfileId,
        ...(active
          ? {
              modelProvider: active.provider,
              modelId: active.modelId,
              apiKey: active.apiKey,
              baseUrl: active.baseUrl,
              isConfigured: profileIsConfigured(active),
            }
          : {}),
        ...(!active
          ? {
              modelProvider: "anthropic",
              modelId: "",
              apiKey: "",
              baseUrl: "",
              isConfigured: false,
            }
          : {}),
      };
    });
  },

  setActiveProfileLocal: (id) => {
    const state = get();
    const active = resolveActive(state.profiles, id);
    if (!active) return;
    set({
      activeProfileId: id,
      modelProvider: active.provider,
      modelId: active.modelId,
      apiKey: active.apiKey,
      baseUrl: active.baseUrl,
      isConfigured: profileIsConfigured(active),
    });
  },

  switchActiveProfile: async (id) => {
    if (window.agentApi) {
      await window.agentApi.setActiveProfile(id);
      await get().loadFromSystem();
    }
  },
}));
