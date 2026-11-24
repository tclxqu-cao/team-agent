import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHeadscaleClient } from "./headscale-client.mjs";

/**
 * Mesh 控制面装配与节点状态：
 *  - 控制面地址/API key 只从环境读取（AGENT_HEADSCALE_URL / AGENT_HEADSCALE_API_KEY），
 *    不进 settings、不进日志、不下发到浏览器；
 *  - 每台安装实例映射一个 headscale user：agentroam-<机器指纹前 12 位>；
 *  - 节点状态落在 <dataDir>/mesh/state.json（CLI onboarding 写入，服务端只读）。
 */
const MACHINE_ID_PATTERN = /^[a-z0-9-]{1,32}$/i;

export function meshUserFor(machineId) {
  const source = typeof machineId === "string" && MACHINE_ID_PATTERN.test(machineId)
    ? machineId
    : createHash("sha256").update(String(machineId ?? "")).digest("hex").slice(0, 12);
  return `agentroam-${source}`.slice(0, 63).toLowerCase();
}

export function createMeshService({ dataDir, env = process.env, request = fetch, serviceId = resolve(dataDir), now = () => Date.now() }) {
  const controlPlaneUrl = typeof env.AGENT_HEADSCALE_URL === "string" && env.AGENT_HEADSCALE_URL.trim()
    ? env.AGENT_HEADSCALE_URL.trim()
    : null;
  const apiKey = typeof env.AGENT_HEADSCALE_API_KEY === "string" && env.AGENT_HEADSCALE_API_KEY.trim()
    ? env.AGENT_HEADSCALE_API_KEY.trim()
    : null;
  const statePath = join(dataDir, "mesh", "state.json");
  let client = null;
  if (controlPlaneUrl && apiKey) {
    try {
      const url = new URL(controlPlaneUrl);
      const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if ((url.protocol === "https:" || (local && url.protocol === "http:")) &&
          url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash) {
        client = createHeadscaleClient({ baseUrl: url.origin, apiKey, request });
      }
    } catch { /* Invalid settings leave the mesh unavailable. */ }
  }
  const user = meshUserFor(createHash("sha256").update(serviceId).digest("hex").slice(0, 24));

  async function readState() {
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch { return null; }
  }

  async function writeState(next) {
    const directory = join(dataDir, "mesh");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${statePath}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...next, updatedAt: new Date(now()).toISOString() }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, statePath);
  }

  /** 对外状态：绝不含 API key 或节点密钥。 */
  async function status() {
    const state = await readState();
    const matchingState = client && state?.controlPlaneUrl === client.baseUrl ? state : null;
    return {
      configured: Boolean(client),
      controlPlaneUrl: client?.baseUrl ?? null,
      phase: matchingState?.phase ?? (client ? "ready" : "unconfigured"),
      hostname: matchingState?.hostname ?? null,
      tailnetIPv4: matchingState?.tailnetIPv4 ?? null,
      dnsName: matchingState?.dnsName ?? null,
      user: matchingState?.user ?? null,
      joinedAt: matchingState?.joinedAt ?? null,
      lastError: matchingState?.lastError ?? null,
      updatedAt: matchingState?.updatedAt ?? null,
    };
  }

  function requireClient() {
    if (!client) throw Object.assign(new Error("未配置 AGENT_HEADSCALE_URL / AGENT_HEADSCALE_API_KEY"), { status: 503 });
    return client;
  }

  return {
    configured: Boolean(client),
    controlPlaneUrl: client?.baseUrl ?? null,
    status,
    async mintNodeKey({ nodeName }) {
      const headscale = requireClient();
      const key = await headscale.createPreAuthKey(await headscale.getOrCreateUser(user));
      return { loginServer: headscale.baseUrl, authkey: key.key, expiresAt: key.expiresAt, user, nodeName };
    },
    async listNodes() {
      return (await requireClient().listNodes()).filter(node => node.user === user);
    },
    async markJoined({ hostname, tailnetIPv4, dnsName }) {
      const current = await status();
      await writeState({ phase: "joined", controlPlaneUrl: client.baseUrl, hostname, tailnetIPv4, dnsName, user,
        joinedAt: current.tailnetIPv4 === tailnetIPv4 && current.joinedAt || new Date(now()).toISOString(), lastError: null });
    },
    async markError(message) {
      const previous = await readState();
      await writeState({ ...(previous ?? {}), controlPlaneUrl: client?.baseUrl, phase: "error", lastError: String(message ?? "unknown error").slice(0, 500) });
    },
    async markOffboarded() {
      await writeState({ phase: "offboarded", controlPlaneUrl: client?.baseUrl, lastError: null });
    },
    async removeDesktopNode(tailnetIPv4) {
      const nodes = await this.listNodes();
      const node = nodes.find(candidate => candidate.ipAddresses.includes(tailnetIPv4));
      if (node) {
        try { await requireClient().deleteNode(node.id); }
        catch (error) { if (error.status !== 404) throw error; }
      }
    },
  };
}
