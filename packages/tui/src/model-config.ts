import { promises as fsp } from "node:fs";
import path from "node:path";

export interface DesktopModelProfile {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  sourcePath: string;
}

export interface ModelSelection {
  source: "tui" | "desktop" | "env" | "manual" | "custom";
  profileId?: string;
  sourcePath?: string;
  endpointId?: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
}

export interface PersistedModelSelection {
  source: "desktop" | "manual" | "custom";
  profileId?: string;
  sourcePath?: string;
  endpointId?: string;
  name: string;
  provider: string;
  modelId: string;
  baseUrl?: string;
}

export interface CustomModelEndpoint {
  id: string;
  name: string;
  baseUrl: string;
  modelsUrl: string;
  apiKey: string;
  defaultModelId: string;
  models: string[];
  updatedAt: string;
}

export interface TuiConfig {
  version: 2;
  active: PersistedModelSelection | null;
  endpoints: CustomModelEndpoint[];
}

export function emptyTuiConfig(): TuiConfig {
  return { version: 2, active: null, endpoints: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPersistedSelection(value: unknown): PersistedModelSelection | null {
  if (!isRecord(value)) return null;
  const source = value.source;
  if (!source || !["desktop", "manual", "custom"].includes(String(source))) return null;
  if (!value.provider || !value.modelId) return null;
  return {
    source: String(source) as PersistedModelSelection["source"],
    profileId: value.profileId ? String(value.profileId) : undefined,
    sourcePath: value.sourcePath ? String(value.sourcePath) : undefined,
    endpointId: value.endpointId ? String(value.endpointId) : undefined,
    name: String(value.name || value.modelId),
    provider: String(value.provider),
    modelId: String(value.modelId),
    baseUrl: value.baseUrl ? String(value.baseUrl) : undefined,
  };
}

function readEndpoint(value: unknown): CustomModelEndpoint | null {
  if (!isRecord(value) || !value.id || !value.baseUrl || !value.modelsUrl || !value.defaultModelId) return null;
  const models = Array.isArray(value.models)
    ? [...new Set(value.models.map(String).filter(Boolean))]
    : [];
  return {
    id: String(value.id),
    name: String(value.name || value.id),
    baseUrl: String(value.baseUrl),
    modelsUrl: String(value.modelsUrl),
    apiKey: String(value.apiKey || ""),
    defaultModelId: String(value.defaultModelId),
    models: models.includes(String(value.defaultModelId)) ? models : [String(value.defaultModelId), ...models],
    updatedAt: String(value.updatedAt || ""),
  };
}

export async function loadTuiConfig(configPath: string): Promise<TuiConfig> {
  try {
    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8")) as unknown;
    if (isRecord(parsed) && parsed.version === 2) {
      const endpoints = Array.isArray(parsed.endpoints)
        ? parsed.endpoints.map(readEndpoint).filter((endpoint): endpoint is CustomModelEndpoint => Boolean(endpoint))
        : [];
      return { version: 2, active: readPersistedSelection(parsed.active), endpoints };
    }
    return { version: 2, active: readPersistedSelection(parsed), endpoints: [] };
  } catch {
    return emptyTuiConfig();
  }
}

export async function loadTuiModelSelection(configPath: string): Promise<PersistedModelSelection | null> {
  return (await loadTuiConfig(configPath)).active;
}

export async function saveTuiConfig(configPath: string, config: TuiConfig): Promise<void> {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await fsp.chmod(temporary, 0o600);
  await fsp.rename(temporary, configPath);
}

function persistedSelection(selection: ModelSelection): PersistedModelSelection {
  const source = selection.source === "custom"
    ? "custom"
    : selection.source === "desktop" || selection.profileId
      ? "desktop"
      : "manual";
  return {
    source,
    profileId: selection.profileId,
    sourcePath: selection.sourcePath,
    endpointId: selection.endpointId,
    name: selection.name,
    provider: selection.provider,
    modelId: selection.modelId,
    baseUrl: selection.baseUrl,
  };
}

export async function saveTuiModelSelection(configPath: string, selection: ModelSelection): Promise<void> {
  const config = await loadTuiConfig(configPath);
  await saveTuiConfig(configPath, { ...config, active: persistedSelection(selection) });
}

export function upsertCustomEndpoint(config: TuiConfig, endpoint: CustomModelEndpoint): TuiConfig {
  const index = config.endpoints.findIndex((candidate) => candidate.id === endpoint.id);
  const endpoints = [...config.endpoints];
  if (index >= 0) endpoints[index] = endpoint;
  else endpoints.push(endpoint);
  return { ...config, endpoints };
}

export function endpointModelSelection(endpoint: CustomModelEndpoint, modelId = endpoint.defaultModelId): ModelSelection {
  return {
    source: "custom",
    endpointId: endpoint.id,
    name: `${endpoint.name} / ${modelId}`,
    provider: "openai",
    modelId,
    apiKey: endpoint.apiKey,
    baseUrl: endpoint.baseUrl,
  };
}

function fromDesktop(profile: DesktopModelProfile, source: ModelSelection["source"]): ModelSelection {
  return { ...profile, source, baseUrl: profile.baseUrl || undefined };
}

export function resolveStartupModel(input: {
  persisted: PersistedModelSelection | null;
  endpoints?: readonly CustomModelEndpoint[];
  profiles: readonly DesktopModelProfile[];
  activeProfileId?: string;
  env: NodeJS.ProcessEnv;
}): ModelSelection | null {
  const { persisted, endpoints = [], profiles, activeProfileId, env } = input;
  if (persisted?.source === "custom") {
    const endpoint = endpoints.find((candidate) => candidate.id === persisted.endpointId);
    if (endpoint?.apiKey) return endpointModelSelection(endpoint, persisted.modelId || endpoint.defaultModelId);
  }
  if (persisted?.source === "desktop") {
    const profile = profiles.find((candidate) =>
      candidate.id === persisted.profileId && (!persisted.sourcePath || candidate.sourcePath === persisted.sourcePath));
    if (profile?.apiKey) return fromDesktop(profile, "tui");
  }
  if (persisted?.source === "manual" && env.AGENT_API_KEY) {
    return {
      source: "tui",
      name: persisted.name || persisted.modelId,
      provider: persisted.provider,
      modelId: persisted.modelId,
      apiKey: env.AGENT_API_KEY,
      baseUrl: persisted.baseUrl || env.AGENT_BASE_URL || undefined,
    };
  }
  const active = profiles.find((profile) => profile.id === activeProfileId && profile.apiKey);
  if (active) return fromDesktop(active, "desktop");
  const firstUsable = profiles.find((profile) => profile.apiKey);
  if (firstUsable) return fromDesktop(firstUsable, "desktop");
  if (!env.AGENT_API_KEY) return null;
  const provider = env.AGENT_MODEL_PROVIDER || "openai";
  const modelId = env.AGENT_MODEL_ID || "gpt-4o";
  return {
    source: "env",
    name: `${provider}/${modelId}`,
    provider,
    modelId,
    apiKey: env.AGENT_API_KEY,
    baseUrl: env.AGENT_BASE_URL || undefined,
  };
}

export function parseManualModel(value: string, env: NodeJS.ProcessEnv): ModelSelection {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error("用法: /model <provider>/<model-id>");
  }
  if (!env.AGENT_API_KEY) throw new Error("手动模型需要 AGENT_API_KEY");
  const provider = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (!provider || !modelId) throw new Error("provider 和 model-id 不能为空");
  return {
    source: "manual",
    name: `${provider}/${modelId}`,
    provider,
    modelId,
    apiKey: env.AGENT_API_KEY,
    baseUrl: env.AGENT_BASE_URL || undefined,
  };
}
