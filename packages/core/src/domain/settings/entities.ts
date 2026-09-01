// ── Settings Domain ──

import type { ReasoningEffort } from "../model/entities.js";

export interface ModelProfile {
  id: string;
  /** Human-readable nickname, e.g. "GPT-4o" */
  name: string;
  provider: string;      // "anthropic" | "openai" | "deepseek"
  modelId: string;
  apiKey: string;
  baseUrl: string;
}

export interface SettingsData {
  /** Flat active-model fields kept for backward compatibility */
  modelProvider: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  maxIterations: number;
  /** Context window size in K tokens (e.g. 100 = 100 000 tokens). Default 100. */
  contextWindow: number;
  workingDirectory: string;
  isConfigured: boolean;
  /** Multi-provider profiles list */
  profiles: ModelProfile[];
  /** ID of the currently active profile (empty string = use flat fields) */
  activeProfileId: string;
  /** Reasoning intensity for main-loop requests. Default "off" = provider default behavior. */
  reasoningEffort?: ReasoningEffort;
}

export interface ISettingsStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  getAll(): SettingsData;
  saveAll(settings: SettingsData): void;
  delete(key: string): void;
}
