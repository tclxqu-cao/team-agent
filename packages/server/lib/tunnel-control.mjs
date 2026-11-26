import { randomUUID } from "node:crypto";

const PAIRING_ROUTES = "/api/desktop/tunnel/routes";

/** Desktop-only control of the CLI-owned tunnel; this server never spawns a tunnel. */
export function createTunnelControlGateway({ desktop, parent = process }) {
  const pending = new Map();
  let status = { phase: "unsupported", mode: "local", provider: "lan", error: "当前后台不支持公网连接控制，请升级后台服务。" };
  if (parent.connected) status = { phase: "connecting", mode: "local", provider: "lan", stage: "connecting" };
  const receive = message => {
    if (message?.type === "agentroam:tunnel-status") status = message.status;
    if (message?.type === "agentroam:pairing-route-result") {
      const finish = pending.get(message.id);
      if (message.error) finish?.(503, { error: message.error });
      else finish?.(200, message.result);
    }
  };
  const disconnect = () => {
    status = { phase: "unsupported", mode: "local", provider: "lan", error: "公网连接管理进程已断开，请检查后台服务。" };
    for (const finish of pending.values()) finish(503, { error: status.error });
  };
  const requestPairingRoute = (req, res, reply) => {
    if (req.method !== "GET" && req.method !== "POST") return reply(405, { error: "Method not allowed" });
    if (!parent.connected || status.phase === "unsupported") return reply(503, { error: status.error || "当前后台不支持切换配对线路。" });
    const route = req.method === "POST" ? new URL(req.url, "http://localhost").searchParams.get("via") : undefined;
    if (req.method === "POST" && !/^(self-hosted|cloudflare|lan|tailscale|(?:\d{1,3}\.){3}\d{1,3})$/.test(route ?? "")) return reply(400, { error: "配对线路无效。" });
    if (pending.size >= 32) return reply(503, { error: "配对线路请求过多，请稍后重试。" });
    const id = randomUUID();
    const release = () => {
      clearTimeout(timer); res.removeListener("close", release);
      return pending.delete(id);
    };
    const finish = (code, body) => { if (release() && !res.destroyed) reply(code, body); };
    const timer = setTimeout(() => finish(503, { error: "准备配对线路超时，请检查服务版本和网络。" }), 38_000);
    pending.set(id, finish);
    res.once("close", release);
    try {
      parent.send({ type: "agentroam:pairing-route", id, route }, error => {
        if (error) finish(503, { error: "配对线路服务已断开。" });
      });
    } catch { finish(503, { error: "无法请求配对线路。" }); }
  };
  parent.on("message", receive);
  parent.on("disconnect", disconnect);
  return {
    handle(req, res) {
      const path = req.url?.split("?")[0];
      if (path !== "/api/desktop/tunnel" && path !== "/api/desktop/tunnel/connect" && path !== PAIRING_ROUTES) return false;
      const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
      if (!desktop.authenticate(req)) { reply(401, { error: "Local desktop authorization required" }); return true; }
      if (path === PAIRING_ROUTES) { requestPairingRoute(req, res, reply); return true; }
      if (req.method === "GET" && path === "/api/desktop/tunnel") { reply(200, status); return true; }
      if (req.method !== "POST" || path !== "/api/desktop/tunnel/connect") { reply(405, { error: "Method not allowed" }); return true; }
      if (!parent.connected || status.phase === "unsupported") { reply(503, status); return true; }
      if (status.phase !== "ready" && status.phase !== "connecting") {
        const previous = status;
        status = { ...status, phase: "connecting", stage: "connecting", error: undefined };
        try {
          parent.send({ type: "agentroam:tunnel-connect" }, error => { if (error) disconnect(); });
        } catch { status = { ...previous, phase: "error", error: "无法请求公网连接，请检查后台服务后重试。" }; }
      }
      reply(202, status);
      return true;
    },
    close() { disconnect(); parent.removeListener("message", receive); parent.removeListener("disconnect", disconnect); },
  };
}
