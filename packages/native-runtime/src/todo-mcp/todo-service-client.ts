import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
export interface TodoClientOptions { serviceId: string; descriptorPath: string; registry?: string }
interface CredentialFile { serviceId: string; token: string; scope: "manage" | "execution" | "relay"; discoveryDirectory?: string }
export class TodoServiceClient {
  constructor(private readonly options: TodoClientOptions, private readonly request: typeof fetch = fetch) {}
  async credential(): Promise<CredentialFile> {
    const info = await stat(this.options.descriptorPath);
    if (process.platform !== "win32" && (info.mode & 0o077)) throw new Error("Todo credential file must have mode 0600");
    const c = JSON.parse(await readFile(this.options.descriptorPath, "utf8"));
    if (c.serviceId !== this.options.serviceId || !/^[a-f0-9]{64}$/.test(c.token)) throw new Error("Todo credential service mismatch");
    return c;
  }
  async call(operation: string, args: unknown = {}): Promise<any> {
    const c = await this.credential();
    const root = this.options.registry ?? c.discoveryDirectory ?? process.env.AGENTROAM_DISCOVERY_DIR ?? join(homedir(), ".agentroam", "services");
    const files = await readdir(root).catch(() => [] as string[]);
    const found: Array<{ url: string; dataDir: string }> = [];
    for (const file of files.filter(f => f.endsWith(".json"))) {
      try {
        const d = JSON.parse(await readFile(join(root, file), "utf8"));
        const url = new URL(d.url);
        if (d.serviceId !== c.serviceId || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) continue;
        const response = await this.request(`${url.origin}/api/internal/todo-mcp`, { method: "POST", headers: { "content-type": "application/json", "x-agentroam-todo-credential": c.token, "x-agentroam-service-id": c.serviceId }, body: JSON.stringify({ operation: "identity" }), signal: AbortSignal.timeout(30000), redirect: "error" });
        if (response.ok && (await response.json() as { serviceId?: string }).serviceId === c.serviceId) found.push(d);
      } catch { /* stale descriptors are expected after a process crash */ }
    }
    if (found.length !== 1) throw new Error(found.length ? "Todo service identity is ambiguous; refusing to choose another data root" : "Selected Todo service is unavailable");
    const response = await this.request(`${found[0].url}/api/internal/todo-mcp`, { method: "POST", headers: { "content-type": "application/json", "x-agentroam-todo-credential": c.token, "x-agentroam-service-id": c.serviceId }, body: JSON.stringify({ operation, args }), signal: AbortSignal.timeout(30000), redirect: "error" });
    const result = await response.json() as { error?: string; code?: string };
    if (!response.ok) throw Object.assign(new Error(result.error ?? "Todo service request failed"), { code: result.code });
    return result;
  }
}
