import type { ModelProfile } from "../../domain/ports/agent-port";

export type ReasoningEffort = "off" | "low" | "medium" | "high";

export interface WebSettings {
  modelProvider: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  maxIterations: number;
  /** Context window in thousands of tokens. */
  contextWindow: number;
  workingDirectory: string;
  profiles: ModelProfile[];
  activeProfileId: string;
  reasoningEffort: ReasoningEffort;
}

const STORAGE_KEY = "webapp.settings.v1";

/**
 * Settings adapter for the web shell. The server keeps the real model
 * configuration in its own env (AGENT_API_KEY/...), so the client ships a
 * placeholder "server-managed" profile purely to satisfy the renderer's
 * isConfigured gate. User edits persist per-device in localStorage.
 */
export class LocalSettingsRepository {
  private cached: WebSettings | null = null;

  get(): WebSettings {
    if (this.cached) return this.cached;
    let stored: Partial<WebSettings> = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<WebSettings>;
    } catch {
      stored = {};
    }
    this.cached = { ...this.defaults(), ...stored };
    return this.cached;
  }

  save(update: Record<string, unknown>): void {
    const current = this.get();
    this.cached = { ...current, ...update } as WebSettings;
    if (update.profiles && !update.activeProfileId) {
      this.cached.activeProfileId = current.activeProfileId;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cached));
  }

  setActiveProfile(profileId: string): void {
    const current = this.get();
    this.cached = { ...current, activeProfileId: profileId };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cached));
  }

  /**
   * Reflect the server's actual model into the managed profile so the
   * settings panel shows what is really serving requests. Local user edits
   * (a real API key) still take precedence as a per-run override.
   */
  reflectServerModel(info: { provider?: string; modelId?: string; baseUrl?: string } | null): void {
    if (!info?.modelId) return;
    const current = this.get();
    const managed = current.profiles.find((p) => p.id === "server-managed");
    if (!managed) return;
    // Once the user supplies real credentials, this entry becomes a local
    // per-run override and must no longer be replaced by server discovery.
    if (managed.apiKey !== "managed") return;
    if (managed.modelId === info.modelId && managed.provider === (info.provider || "openai")) return;
    const modelId = info.modelId;
    const provider = info.provider || "openai";
    const baseUrl = info.baseUrl || "";
    this.cached = {
      ...current,
      profiles: current.profiles.map((p) =>
        p.id === "server-managed"
          ? {
              ...p,
              name: `服务端 · ${modelId}`,
              provider,
              modelId,
              baseUrl,
            }
          : p,
      ),
      modelProvider: provider,
      modelId,
      baseUrl: baseUrl || current.baseUrl,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cached));
  }

  /**
   * The active profile as a per-run model override for the server, or null
   * while the user has not configured their own credentials (the placeholder
   * "managed" profile keeps the renderer's isConfigured gate satisfied while
   * the server uses its own env model).
   */
  getModelOverride(): { provider: string; apiKey: string; modelId: string; baseUrl?: string } | null {
    const settings = this.get();
    const active = settings.profiles.find((p) => p.id === settings.activeProfileId) ?? null;
    const provider = active?.provider ?? settings.modelProvider;
    const apiKey = active?.apiKey ?? settings.apiKey;
    const modelId = active?.modelId ?? settings.modelId;
    const baseUrl = active?.baseUrl ?? settings.baseUrl;
    if (!apiKey || apiKey === "managed" || !modelId || modelId === "server") return null;
    return { provider, apiKey, modelId, ...(baseUrl ? { baseUrl } : {}) };
  }

  /** Persisted reasoning intensity, defaulting to "off" (provider default behavior). */
  getReasoningEffort(): ReasoningEffort {
    const effort = this.get().reasoningEffort;
    return ["off", "low", "medium", "high"].includes(effort) ? effort : "off";
  }

  getRunLimits(): { maxIterations: number; maxTokens: number } {
    const settings = this.get();
    const maxIterations = Math.min(50, Math.max(1, Math.trunc(Number(settings.maxIterations) || 10)));
    const contextWindowK = Math.min(2_000, Math.max(8, Math.trunc(Number(settings.contextWindow) || 100)));
    return { maxIterations, maxTokens: contextWindowK * 1_000 };
  }

  private defaults(): WebSettings {
    const profile: ModelProfile = {
      id: "server-managed",
      name: "服务端托管",
      provider: "openai",
      modelId: "server",
      apiKey: "managed",
      baseUrl: "",
    };
    return {
      modelProvider: profile.provider,
      modelId: profile.modelId,
      apiKey: profile.apiKey,
      baseUrl: "",
      maxIterations: 10,
      contextWindow: 100,
      workingDirectory: "/",
      profiles: [profile],
      activeProfileId: profile.id,
      reasoningEffort: "off",
    };
  }
}
