/** Desktop-only control of the CLI-owned tunnel; this server never spawns a tunnel. */
export function createTunnelControlGateway({ desktop, parent = process }) {
  let status = { phase: "unsupported", mode: "local", provider: "lan", error: "当前后台不支持公网连接控制，请升级后台服务。" };
  if (parent.connected) status = { phase: "connecting", mode: "local", provider: "lan", stage: "connecting" };
  const receive = message => {
    if (message?.type === "agentroam:tunnel-status") status = message.status;
  };
  const disconnect = () => { status = { phase: "unsupported", mode: "local", provider: "lan", error: "公网连接管理进程已断开，请检查后台服务。" }; };
  parent.on("message", receive);
  parent.on("disconnect", disconnect);
  return {
    handle(req, res) {
      const path = req.url?.split("?")[0];
      if (path !== "/api/desktop/tunnel" && path !== "/api/desktop/tunnel/connect") return false;
      const reply = (code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
      if (!desktop.authenticate(req)) { reply(401, { error: "Local desktop authorization required" }); return true; }
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
    close() { parent.removeListener("message", receive); parent.removeListener("disconnect", disconnect); },
  };
}
