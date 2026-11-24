import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateJson } from "../service/service-files.js";

function configPath(dataDir: string): string {
  return join(dataDir, "mesh", "control-plane.json");
}

export async function saveMeshEnvironment(dataDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const url = env.AGENT_HEADSCALE_URL?.trim();
  const apiKey = env.AGENT_HEADSCALE_API_KEY?.trim();
  if (!url && !apiKey) return;
  if (!url || !apiKey) throw new Error("请同时设置 AGENT_HEADSCALE_URL 和 AGENT_HEADSCALE_API_KEY");
  await writePrivateJson(configPath(dataDir), { url, apiKey });
}

export async function loadMeshEnvironment(dataDir: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.AGENT_HEADSCALE_URL !== undefined || env.AGENT_HEADSCALE_API_KEY !== undefined) return {};
  const raw = await readFile(configPath(dataDir), "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.url === "string" && typeof parsed?.apiKey === "string") {
      return { AGENT_HEADSCALE_URL: parsed.url, AGENT_HEADSCALE_API_KEY: parsed.apiKey };
    }
  } catch { /* Report a malformed private config without its contents. */ }
  throw new Error("无法读取组网控制面配置");
}
