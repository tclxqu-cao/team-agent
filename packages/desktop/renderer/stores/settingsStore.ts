import { create } from "zustand";
import type { ModelProfile } from "../global.d.ts";

interface SettingsState {
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

function resolveActive(profiles: ModelProfile[], id: string): ModelProfile | null {
  return profiles.find((p) => p.id === id) ?? null;
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
      updated.isConfigured = Boolean(updated.apiKey && updated.modelId);
      return updated;
    }),

  loadFromSystem: async () => {
    if (!window.agentApi) return;
    try {
      const s = await window.agentApi.getSettings();
      const profiles = (s.profiles ?? []) as ModelProfile[];
      const activeProfileId = s.activeProfileId ?? "";
      const active = resolveActive(profiles, activeProfileId);
      set({
        modelProvider: active?.provider ?? s.modelProvider ?? "anthropic",
        modelId: active?.modelId ?? s.modelId ?? "claude-sonnet-4-6",
        apiKey: active?.apiKey ?? s.apiKey ?? "",
        baseUrl: active?.baseUrl ?? s.baseUrl ?? "",
        maxIterations: s.maxIterations ?? 10,
        contextWindow: s.contextWindow ?? 100,
        workingDirectory: s.workingDirectory ?? "/",
        isConfigured: Boolean((active?.apiKey ?? s.apiKey) && (active?.modelId ?? s.modelId)),
        profiles,
        activeProfileId,
        reasoningEffort: (["off", "low", "medium", "high"].includes(s.reasoningEffort ?? "")
          ? (s.reasoningEffort as "off" | "low" | "medium" | "high")
          : "off"),
      });
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  },

  saveToSystem: async () => {
    if (!window.agentApi) return;
    const state = get();
    await window.agentApi.saveSettings({
      modelProvider: state.modelProvider,
      modelId: state.modelId,
      apiKey: state.apiKey,
      baseUrl: state.baseUrl,
      maxIterations: state.maxIterations,
      contextWindow: state.contextWindow,
      workingDirectory: state.workingDirectory,
      isConfigured: state.isConfigured,
      profiles: state.profiles,
      activeProfileId: state.activeProfileId,
      reasoningEffort: state.reasoningEffort,
    });
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
          isConfigured: Boolean(updated.apiKey && updated.modelId),
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
              isConfigured: Boolean(active.apiKey && active.modelId),
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
      isConfigured: Boolean(active.apiKey && active.modelId),
    });
  },

  switchActiveProfile: async (id) => {
    get().setActiveProfileLocal(id);
    if (window.agentApi) {
      await window.agentApi.setActiveProfile(id);
    }
  },
}));
