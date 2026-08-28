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
  source: "tui" | "desktop" | "env" | "manual";
  profileId?: string;
  sourcePath?: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
}

export interface PersistedModelSelection {
  source: "desktop" | "manual";
  profileId?: string;
  sourcePath?: string;
  name: string;
  provider: string;
  modelId: string;
  baseUrl?: string;
}

export async function loadTuiModelSelection(configPath: string): Promise<PersistedModelSelection | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(configPath, "utf8")) as PersistedModelSelection;
    if (!parsed.provider || !parsed.modelId || !["desktop", "manual"].includes(parsed.source)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveTuiModelSelection(configPath: string, selection: ModelSelection): Promise<void> {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  const persisted: PersistedModelSelection = {
    source: selection.source === "desktop" || selection.profileId ? "desktop" : "manual",
    profileId: selection.profileId,
    sourcePath: selection.sourcePath,
    name: selection.name,
    provider: selection.provider,
    modelId: selection.modelId,
    baseUrl: selection.baseUrl,
  };
  const temporary = `${configPath}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(persisted, null, 2) + "\n", { mode: 0o600 });
  await fsp.chmod(temporary, 0o600);
  await fsp.rename(temporary, configPath);
}

function fromDesktop(profile: DesktopModelProfile, source: ModelSelection["source"]): ModelSelection {
  return { ...profile, source, baseUrl: profile.baseUrl || undefined };
}

export function resolveStartupModel(input: {
  persisted: PersistedModelSelection | null;
  profiles: readonly DesktopModelProfile[];
  activeProfileId?: string;
  env: NodeJS.ProcessEnv;
}): ModelSelection | null {
  const { persisted, profiles, activeProfileId, env } = input;
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
