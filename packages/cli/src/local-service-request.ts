import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface Descriptor { protocol: number; instanceId: string; pid: number; url: string; dataDir: string; token: string }
export interface LocalRequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  registry?: string;
  request?: typeof fetch;
  timeoutMs?: number;
}

export class LocalServiceHttpError extends Error {
  constructor(readonly status: number) { super(`本机服务请求失败 (HTTP ${status})`); }
}

/** Resolve an identity-checked loopback service; never send its token to a tunnel. */
export async function localServiceRequest<T>(dataDir: string, path: string, options: LocalRequestOptions = {}): Promise<T> {
  if (!path.startsWith("/api/")) throw new Error("无效的本机服务路径");
  const request = options.request ?? fetch;
  const directory = options.registry ?? process.env.AGENTROAM_DISCOVERY_DIR ?? join(homedir(), ".agentroam", "services");
  const names = await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const candidates: Descriptor[] = [];
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    try {
      const d = JSON.parse(await readFile(join(directory, name), "utf8")) as Descriptor;
      const url = new URL(d.url);
      if (d.protocol !== 1 || typeof d.instanceId !== "string" || !Number.isSafeInteger(d.pid) || d.pid <= 0 || ![resolve(dataDir), resolve(dataDir, "data")].includes(d.dataDir) || !/^[a-f0-9]{64}$/.test(d.token)) continue;
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.username || url.password || url.search || url.hash) continue;
      const response = await request(new URL("/api/desktop/identity", url), { headers: { "x-agentroam-desktop-token": d.token }, redirect: "error", signal: AbortSignal.timeout(1500) });
      if (!response.ok) continue;
      const identity = await response.json() as Partial<Descriptor>;
      if (identity.protocol === 1 && identity.instanceId === d.instanceId && identity.dataDir === d.dataDir) candidates.push(d);
    } catch { /* Stale descriptors are expected after a process crash. */ }
  }
  if (candidates.length !== 1) throw new Error(candidates.length ? "多个服务使用此数据目录，请先停止多余实例" : "未找到运行中的 AgentRoam 服务，请先启动服务或指定 --data-dir");
  const d = candidates[0]!;
  const url = new URL(path, d.url);
  if (url.origin !== new URL(d.url).origin) throw new Error("无效的本机服务路径");
  const response = await request(url, {
    method: options.method ?? "GET",
    headers: { "x-agentroam-desktop-token": d.token, "content-type": "application/json", origin: new URL(d.url).origin },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
  if (!response.ok) throw new LocalServiceHttpError(response.status);
  return response.json() as Promise<T>;
}
