import { SQLiteSettingsStore, getDatabase, type SettingsData, type ModelProfile } from "@agent/core";
import { getServerBaseDir } from "./server-data-dir";
import { createHash } from "node:crypto";

export const STORED_SECRET = "__agentroam_stored_secret__";
export type SharedSettings = SettingsData & { activeAgentIds: string[]; revision: number };

export class SettingsValidationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** The only persistent source of Customer Agent configuration for both clients. */
export class SharedSettingsService {
  readonly store: SQLiteSettingsStore;
  constructor(private readonly baseDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.store = new SQLiteSettingsStore(baseDir);
    if (this.store.get("sharedSettingsInitialized") === null) {
      getDatabase(baseDir).db.transaction(() => {
        // Import legacy server env only once, and never replace existing data.
        if (!this.store.get("profiles") && !this.store.get("apiKey") && env.AGENT_API_KEY) {
          const profile: ModelProfile = { id: "server-default", name: "服务端默认", provider: env.AGENT_MODEL_PROVIDER || "openai", modelId: env.AGENT_MODEL_ID || "gpt-4o", apiKey: env.AGENT_API_KEY, baseUrl: env.AGENT_BASE_URL || "" };
          this.store.saveAll({ ...this.store.getAll(), profiles: [profile], activeProfileId: profile.id, modelProvider: profile.provider, modelId: profile.modelId, apiKey: profile.apiKey, baseUrl: profile.baseUrl, isConfigured: true });
        }
        this.store.set("sharedSettingsInitialized", "1");
      })();
    }
  }

  read(): SharedSettings {
    let activeAgentIds: string[] = [];
    try { activeAgentIds = JSON.parse(this.store.get("activeAgentIds") || "[]"); } catch {}
    return { ...this.store.getAll(), activeAgentIds, revision: Number(this.store.get("sharedSettingsRevision") || 0) };
  }

  publicView(): SharedSettings & { settingsSpaceId: string } {
    const settings = this.read();
    return { ...settings, settingsSpaceId: createHash("sha256").update(this.baseDir).digest("hex").slice(0, 24), apiKey: settings.apiKey ? STORED_SECRET : "", profiles: settings.profiles.map((profile) => ({ ...profile, apiKey: profile.apiKey ? STORED_SECRET : "" })) };
  }

  save(input: Record<string, unknown>): SharedSettings {
    return getDatabase(this.baseDir).db.transaction(() => {
      const current = this.read();
      if (input.revision !== undefined && input.revision !== current.revision) throw new SettingsValidationError("设置已被另一端修改，请重新加载后保存", 409);
      const next = { ...current };
      for (const key of ["modelProvider", "modelId", "baseUrl", "workingDirectory", "activeProfileId"] as const) {
        if (input[key] !== undefined) {
          if (typeof input[key] !== "string") throw new SettingsValidationError(`${key} 必须是字符串`);
          next[key] = input[key];
        }
      }
      if (input.maxIterations !== undefined) {
        if (typeof input.maxIterations !== "number" || !Number.isSafeInteger(input.maxIterations) || input.maxIterations < 0) {
          throw new SettingsValidationError("maxIterations 必须是非负整数");
        }
        next.maxIterations = input.maxIterations;
      }
      if (input.contextWindow !== undefined) {
        if (typeof input.contextWindow !== "number" || !Number.isFinite(input.contextWindow) || input.contextWindow < 8 || input.contextWindow > 2000) {
          throw new SettingsValidationError("contextWindow 超出范围");
        }
        next.contextWindow = input.contextWindow;
      }
      if (input.reasoningEffort !== undefined) {
        if (!["off", "low", "medium", "high"].includes(String(input.reasoningEffort))) throw new SettingsValidationError("reasoningEffort 无效");
        next.reasoningEffort = input.reasoningEffort as SettingsData["reasoningEffort"];
      }
      if (input.apiKey !== undefined) next.apiKey = preserveSecret(input.apiKey, current.apiKey);
      if (input.profiles !== undefined) {
        if (!Array.isArray(input.profiles) || input.profiles.length > 100) throw new SettingsValidationError("profiles 必须是数组");
        const ids = new Set<string>();
        next.profiles = input.profiles.map((raw) => {
          if (!raw || typeof raw !== "object") throw new SettingsValidationError("profile 无效");
          for (const key of ["id", "name", "provider", "modelId", "baseUrl"]) if (typeof raw[key] !== "string") throw new SettingsValidationError(`profile.${key} 无效`);
          if (!raw.id || ids.has(raw.id)) throw new SettingsValidationError("profile.id 重复或为空");
          ids.add(raw.id);
          if (!["openai", "anthropic", "deepseek", "aihub"].includes(raw.provider)) throw new SettingsValidationError("不支持的模型提供方");
          if (
            raw.maxOutputTokens !== undefined
            && (typeof raw.maxOutputTokens !== "number"
              || !Number.isInteger(raw.maxOutputTokens)
              || raw.maxOutputTokens < 256
              || raw.maxOutputTokens > 131_072)
          ) throw new SettingsValidationError("profile.maxOutputTokens 超出范围");
          if (
            raw.requestTimeoutSeconds !== undefined
            && (typeof raw.requestTimeoutSeconds !== "number"
              || !Number.isInteger(raw.requestTimeoutSeconds)
              || raw.requestTimeoutSeconds < 30
              || raw.requestTimeoutSeconds > 1_800)
          ) throw new SettingsValidationError("profile.requestTimeoutSeconds 超出范围");
          return {
            id: raw.id,
            name: raw.name,
            provider: raw.provider,
            modelId: raw.modelId,
            baseUrl: raw.baseUrl,
            apiKey: preserveSecret(raw.apiKey, current.profiles.find((p) => p.id === raw.id)?.apiKey || ""),
            ...(raw.maxOutputTokens === undefined ? {} : { maxOutputTokens: raw.maxOutputTokens }),
            ...(raw.requestTimeoutSeconds === undefined ? {} : { requestTimeoutSeconds: raw.requestTimeoutSeconds }),
          };
        });
      }
      const active = next.profiles.find((profile) => profile.id === next.activeProfileId);
      if (next.activeProfileId && !active) throw new SettingsValidationError("找不到当前配置档案");
      if (active) Object.assign(next, { modelProvider: active.provider, modelId: active.modelId, apiKey: active.apiKey, baseUrl: active.baseUrl });
      if (input.activeAgentIds !== undefined) {
        if (!Array.isArray(input.activeAgentIds) || !input.activeAgentIds.every((id) => typeof id === "string")) throw new SettingsValidationError("activeAgentIds 无效");
        next.activeAgentIds = [...new Set(input.activeAgentIds)] as string[];
      }
      next.isConfigured = next.modelProvider === "aihub"
        ? Boolean(next.modelId)
        : Boolean(next.apiKey && next.modelId);
      this.store.saveAll(next);
      this.store.set("activeAgentIds", JSON.stringify(next.activeAgentIds));
      this.store.set("sharedSettingsRevision", String(current.revision + 1));
      return this.publicView();
    })();
  }
}

function preserveSecret(value: unknown, existing: string): string {
  if (value === undefined || value === "" || value === STORED_SECRET) return existing;
  if (typeof value !== "string" || value.length > 16_384) throw new SettingsValidationError("apiKey 无效");
  return value;
}

let singleton: SharedSettingsService | undefined;
export function sharedSettings(): SharedSettingsService {
  return singleton ??= new SharedSettingsService(getServerBaseDir());
}
