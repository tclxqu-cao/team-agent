import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHeadscaleClient } from "./headscale-client.mjs";

/**
 * Mesh 控制面装配与节点状态：
 *  - 控制面凭据从环境读取，不进 settings、日志和浏览器；
 *  - 每台安装实例使用独立的 Headscale 用户。
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
  const credential = env.AGENTROAM_MESH_CREDENTIAL?.trim();
  const statePath = join(dataDir, "mesh", "state.json");
  let client = null;
  let enrollmentId = null;
  if (controlPlaneUrl && (apiKey || credential)) {
    try {
      const url = new URL(controlPlaneUrl);
      const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
      if ((url.protocol === "https:" || (local && url.protocol === "http:")) &&
          url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash) {
        if (credential && !apiKey && url.protocol === "https:" && /^[A-Za-z0-9_-]{43}$/.test(credential)) {
          client = createEnrollmentClient(url.origin, credential, request);
          enrollmentId = createHash("sha256").update(credential).digest("hex");
        } else if (apiKey && !credential) {
          client = createHeadscaleClient({ baseUrl: url.origin, apiKey, request });
        }
      }
    } catch { /* Invalid settings leave the mesh unavailable. */ }
  }
  const manualUser = meshUserFor(createHash("sha256").update(serviceId).digest("hex").slice(0, 24));

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
    const matchingState = client && state?.controlPlaneUrl === client.baseUrl
      && (state.enrollmentId ?? null) === enrollmentId ? state : null;
    const dnsName = matchingState?.dnsName ?? null;
    const phase = matchingState?.phase ?? (client ? "ready" : "unconfigured");
    return {
      configured: Boolean(client),
      controlPlaneUrl: client?.baseUrl ?? null,
      phase,
      hostname: matchingState?.hostname ?? null,
      tailnetIPv4: matchingState?.tailnetIPv4 ?? null,
      dnsName,
      accessUrl: phase === "joined" && dnsName ? `http://${dnsName}` : null,
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

  let activeUser = null;

  return {
    configured: Boolean(client),
    controlPlaneUrl: client?.baseUrl ?? null,
    status,
    async mintNodeKey({ nodeName }) {
      const headscale = requireClient();
      if (enrollmentId) {
        const issued = await headscale.mintNodeKey();
        activeUser = issued.user;
        return { ...issued, nodeName };
      }
      const key = await headscale.createPreAuthKey(await headscale.getOrCreateUser(manualUser));
      return { loginServer: headscale.baseUrl, authkey: key.key, expiresAt: key.expiresAt, user: manualUser, nodeName };
    },
    async listNodes() {
      const nodes = await requireClient().listNodes();
      return enrollmentId ? nodes : nodes.filter(node => node.user === manualUser);
    },
    async markJoined({ hostname, tailnetIPv4, dnsName }) {
      const current = await status();
      let user = manualUser;
      if (enrollmentId) user = activeUser ?? current.user ?? (await client.listNodes()).find(node => node.ipAddresses.includes(tailnetIPv4))?.user ?? null;
      await writeState({ phase: "joined", controlPlaneUrl: client.baseUrl, ...(enrollmentId && { enrollmentId }), hostname, tailnetIPv4, dnsName, user,
        joinedAt: current.tailnetIPv4 === tailnetIPv4 && current.joinedAt || new Date(now()).toISOString(), lastError: null });
    },
    async markError(message) {
      const previous = await readState();
      await writeState({ ...(previous ?? {}), controlPlaneUrl: client?.baseUrl, enrollmentId, phase: "error", lastError: String(message ?? "unknown error").slice(0, 500) });
    },
    async markOffboarded() {
      await writeState({ phase: "offboarded", controlPlaneUrl: client?.baseUrl, enrollmentId, lastError: null });
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

function createEnrollmentClient(baseUrl, credential, request) {
  async function api(method, path) {
    const response = await request(`${baseUrl}/agentroam-enrollment/v1/${path}`, {
      method, headers: { authorization: `Bearer ${credential}` },
      redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`组网服务请求失败 (HTTP ${response.status})`);
    return response.json();
  }

  return {
    baseUrl,
    async mintNodeKey() {
      const { authkey, expiresAt, user, loginServer } = await api("POST", "node-key");
      if (loginServer !== baseUrl || typeof authkey !== "string" || !authkey || !/^agentroam-invite-[a-f0-9]{24}$/.test(user)) {
        throw new Error("组网服务返回无效的设备凭据");
      }
      return { loginServer, authkey, expiresAt, user };
    },
    async listNodes() { return (await api("GET", "nodes")).nodes; },
    async deleteNode(id) { await api("DELETE", `nodes/${encodeURIComponent(id)}`); },
  };
}
