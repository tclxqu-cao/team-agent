import { randomBytes } from "node:crypto";
import { link, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateJson } from "../service/service-files.js";

const DEFAULT_CONTROL_PLANE = "https://headscale.kaiwuyouwei.com";
const SECRET = /^[A-Za-z0-9_-]{43}$/;

function configPath(dataDir: string): string {
  return join(dataDir, "mesh", "control-plane.json");
}

export async function saveMeshEnvironment(dataDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const url = env.AGENT_HEADSCALE_URL?.trim();
  const apiKey = env.AGENT_HEADSCALE_API_KEY?.trim();
  const code = env.AGENTROAM_MESH_ACTIVATION_CODE?.trim();
  if (code) {
    if (apiKey || env.AGENTROAM_MESH_CREDENTIAL) throw new Error("组网激活码不能与其他组网凭据同时使用");
    await activateMesh(dataDir, url ?? DEFAULT_CONTROL_PLANE, code);
    return;
  }
  if (!url && !apiKey) return;
  if (!url || !apiKey) throw new Error("请同时设置 AGENT_HEADSCALE_URL 和 AGENT_HEADSCALE_API_KEY");
  await writePrivateJson(configPath(dataDir), { url, apiKey });
}

/** Keep the same credential after a lost activation response. The code itself is never stored. */
async function activateMesh(dataDir: string, url: string, code: string): Promise<void> {
  const plane = new URL(url);
  if (plane.protocol !== "https:" || plane.username || plane.password || plane.pathname !== "/" || plane.search || plane.hash) {
    throw new Error("组网激活需要 HTTPS 控制面地址");
  }
  if (!SECRET.test(code)) throw new Error("无效的组网激活码");
  const path = configPath(dataDir);
  if (!await readMeshConfig(dataDir)) {
    const temporary = `${path}.${randomBytes(8).toString("hex")}.pending`;
    await writePrivateJson(temporary, { url: plane.origin, credential: randomBytes(32).toString("base64url") });
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { await rm(temporary, { force: true }); }
  }
  const config = await readMeshConfig(dataDir);
  if (config?.url !== plane.origin || !config.credential) throw new Error("此数据目录已有其他组网配置");
  if (config.activated) return;
  const response = await fetch(new URL("/agentroam-enrollment/v1/activate", plane), {
    method: "POST",
    headers: { authorization: `Bearer ${config.credential}`, "content-type": "application/json" },
    body: JSON.stringify({ code }),
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    if ([400, 403].includes(response.status)) {
      throw new Error("组网激活码已失效、无效或已被另一台设备使用");
    }
    throw new Error(`组网激活失败 (HTTP ${response.status})`);
  }
  await writePrivateJson(path, { ...config, activated: true });
}

interface MeshConfig { url: string; apiKey?: string; credential?: string; activated?: boolean }

async function readMeshConfig(dataDir: string): Promise<MeshConfig | null> {
  const raw = await readFile(configPath(dataDir), "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return null;
  try {
    const config = JSON.parse(raw);
    if (typeof config?.url === "string" && (typeof config.apiKey === "string" || (typeof config.credential === "string" && SECRET.test(config.credential)))) return config;
  } catch { /* Report a malformed private config without its contents. */ }
  throw new Error("无法读取组网控制面配置");
}

export async function loadMeshEnvironment(dataDir: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (env.AGENTROAM_MESH_ACTIVATION_CODE?.trim()) await saveMeshEnvironment(dataDir, env);
  else if (env.AGENT_HEADSCALE_URL !== undefined || env.AGENT_HEADSCALE_API_KEY !== undefined || env.AGENTROAM_MESH_CREDENTIAL !== undefined) return {};
  const config = await readMeshConfig(dataDir);
  if (config?.apiKey) return { AGENT_HEADSCALE_URL: config.url, AGENT_HEADSCALE_API_KEY: config.apiKey };
  if (config?.activated && config.credential) return { AGENT_HEADSCALE_URL: config.url, AGENTROAM_MESH_CREDENTIAL: config.credential };
  return {};
}
