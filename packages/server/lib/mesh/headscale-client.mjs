/**
 * Headscale v1 REST 最小客户端（服务端唯一实现）。
 * 认证：Authorization: Bearer <api key>（headscale apikeys create 签发）。
 * 官方响应包装：{user} / {preAuthKey} / {nodes:[…]}；错误体可能是 {message} 或 {error}。
 */

export class HeadscaleHttpError extends Error {
  constructor(status, detail) {
    super(`headscale API ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

export function createHeadscaleClient({ baseUrl, apiKey, request = fetch, timeoutMs = 15_000 }) {
  const base = new URL(baseUrl).origin;

  async function api(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("headscale request timed out")), timeoutMs);
    timer.unref?.();
    try {
      const response = await request(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        let detail = raw.slice(0, 400);
        try {
          const parsed = JSON.parse(raw);
          detail = typeof parsed.message === "string" ? parsed.message : typeof parsed.error === "string" ? parsed.error : detail;
        } catch { /* 保留原文 */ }
        throw new HeadscaleHttpError(response.status, detail);
      }
      return raw ? JSON.parse(raw) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl: base,
    async getOrCreateUser(name) {
      let user;
      try {
        user = (await api("POST", "/api/v1/user", { name })).user;
      } catch (error) {
        if (!(error instanceof HeadscaleHttpError) || (error.status !== 409 && !/already exists|UNIQUE constraint/i.test(error.detail))) throw error;
        const result = await api("GET", `/api/v1/user?name=${encodeURIComponent(name)}`);
        user = result.users?.find(candidate => candidate.name === name);
      }
      if (!/^[1-9][0-9]*$/.test(String(user?.id))) throw new Error("Headscale 未返回有效用户 ID");
      return String(user.id);
    },
    async createPreAuthKey(user, { expirationSeconds = 900 } = {}) {
      const expiration = new Date(Date.now() + expirationSeconds * 1000).toISOString();
      const result = await api("POST", "/api/v1/preauthkey", {
        user, reusable: false, ephemeral: false, expiration,
      });
      const key = result?.preAuthKey?.key;
      if (typeof key !== "string" || !key) throw new Error("headscale preauthkey response missing key");
      return { key, expiresAt: typeof result.preAuthKey.expiration === "string" ? result.preAuthKey.expiration : null };
    },
    async listNodes() {
      const result = await api("GET", "/api/v1/node");
      return (Array.isArray(result?.nodes) ? result.nodes : []).map((node) => ({
        id: String(node?.id ?? ""),
        name: typeof node?.name === "string" ? node.name : "",
        ipAddresses: Array.isArray(node?.ipAddresses) ? node.ipAddresses : [],
        user: typeof node?.user === "string" ? node.user : typeof node?.user?.name === "string" ? node.user.name : null,
      })).filter((node) => node.id && node.name);
    },
    async deleteNode(id) {
      await api("DELETE", `/api/v1/node/${encodeURIComponent(id)}`);
    },
  };
}
