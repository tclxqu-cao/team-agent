import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DevicePairingStore } from "./device-pairing-store.mjs";
import { PAIRING_PAGE } from "./pairing-page.mjs";
import { handlePwaAsset } from "./pwa-assets.mjs";

export const PENDING_COOKIE = "agentroam_pending_pairing";
export const DEVICE_COOKIE = "agentroam_device_session";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const NATIVE_ORIGINS = new Set(["capacitor://localhost", "https://localhost", "http://localhost", "ionic://localhost"]);
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const error = (message, status = 401) => Object.assign(new Error(message), { status });

function tokenFrom(req, name = DEVICE_COOKIE) {
  const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function readJson(req) {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw error("JSON required", 415);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw error("Request too large", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw error("Invalid JSON", 400); }
}

/** The only public operations are readiness, the pairing page, and code exchange. */
export function createDevicePairingGateway({ dataDir, desktop, owner, consoleStore, store = new DevicePairingStore(dataDir), trustProxy = process.env.AGENT_TRUST_TUNNEL_PROXY === "1", allowedOrigins = process.env.AGENT_WEB_ALLOWED_ORIGINS || "", sdkToken = process.env.AGENT_SDK_TOKEN, testNoPairing = false }) {
  const testId = "test-browser";
  const activeDevice = (id) => id === testId ? testNoPairing && !store.isLocked() : store.active(id);
  const sockets = new Map();
  const streams = new Map();
  const localNonces = new Map();
  const extras = new Set(allowedOrigins.split(",").map((value) => value.trim()).filter(Boolean));
  const proxyTrusted = (req) => trustProxy && LOOPBACK.has(req.socket.remoteAddress);
  const protocol = (req) => proxyTrusted(req) && req.headers["x-forwarded-proto"] === "https" ? "https" : req.socket.encrypted ? "https" : "http";
  const originAllowed = (req) => {
    const host = proxyTrusted(req) ? req.headers["x-forwarded-host"] || req.headers.host : req.headers.host;
    const origin = req.headers.origin;
    return typeof origin === "string" && (origin === `${protocol(req)}://${host}` || extras.has(origin));
  };
  const cookie = (req, token, maxAge = 30 * 24 * 60 * 60, name = DEVICE_COOKIE) => `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${protocol(req) === "https" ? "; Secure" : ""}`;
  const principal = (device) => ({ ...owner, deviceId: device.id, sessionId: device.id });
  const sweep = () => {
    for (const [ws, id] of sockets) if (!activeDevice(id)) { sockets.delete(ws); ws.close(4003, "device authorization revoked or expired"); ws.terminate(); }
    for (const [res, id] of streams) if (store.isLocked() || (id !== "sdk" && !activeDevice(id))) { streams.delete(res); res.destroy(); }
  };
  const recentInput = new Map();
  const auditOperation = (auth, action, outcome) => {
    const actor = auth?.deviceId || "desktop";
    if (action === "ws.term:input") {
      const key = `${actor}:${outcome}`;
      if (Date.now() - (recentInput.get(key) || 0) < 60_000) return;
      recentInput.set(key, Date.now());
      for (const [old, at] of recentInput) if (Date.now() - at > 60_000) recentInput.delete(old);
    }
    store.audit(action, actor, null, outcome);
  };
  const timer = setInterval(sweep, 1000);
  timer.unref();

  return {
    store,
    auditOperation,
    async handle(req, res) {
      if (handlePwaAsset(req, res)) return true;
      // Never trust identity forwarded by a client (including a desktop caller).
      delete req.headers["x-agentroam-device-id"];
      try {
        const url = new URL(req.url, "http://gateway.local");
        const path = url.pathname;
        const native = NATIVE_ORIGINS.has(req.headers.origin);
        if (native && path.startsWith("/api/") && !path.startsWith("/api/pairing/admin/")) {
          res.setHeader("access-control-allow-origin", req.headers.origin);
          res.setHeader("vary", "Origin");
          if (req.method === "OPTIONS") {
            res.writeHead(204, { "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS", "access-control-allow-headers": "authorization,content-type,last-event-id" });
            res.end(); return true;
          }
        }
        const sdkPath = /^(?:\/api\/auth\/verify|\/api\/sessions(?:\/[^/]+)?|\/api\/remote-tools\/register|\/api\/agent\/(?:run|stream|abort|answer))$/.test(path);
        const suppliedSdkToken = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : path === "/api/agent/stream" ? url.searchParams.get("token") : null;
        const sdk = !!sdkToken && sdkPath && typeof suppliedSdkToken === "string" && timingSafeEqual(createHash("sha256").update(sdkToken).digest(), createHash("sha256").update(suppliedSdkToken).digest());
        // Do not let legacy SDK query credentials reach framework access logs.
        if (path === "/api/agent/stream" && url.searchParams.has("token")) {
          url.searchParams.delete("token");
          req.url = url.pathname + url.search;
        }
        const local = desktop.authenticate(req);
        const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
        const token = bearer || tokenFrom(req);
        const device = store.authenticate(token);
        const test = testNoPairing && !store.isLocked() && !device && !local && !path.startsWith("/api/pairing/");
        if (path === "/api/web-auth/status" && req.method === "GET") {
          json(res, 200, { needsSetup: false, authenticated: !!device || test, pairingRequired: !device && !test, locked: store.isLocked() }); return true;
        }
        if (path.startsWith("/api/pairing/admin/")) {
          if (!local) throw error("Local CLI authorization required");
          const action = path.slice("/api/pairing/admin/".length);
          if (action === "code" && req.method === "POST") { await readJson(req); json(res, 200, store.createCode()); return true; }
          if (action === "qr" && req.method === "POST") { await readJson(req); json(res, 200, store.createQr()); return true; }
          if (action === "requests" && req.method === "GET") { json(res, 200, { requests: store.pending(), locked: store.isLocked(), qrClaimed: store.qrClaimed() }); return true; }
          if (action === "audit" && req.method === "GET") { json(res, 200, { events: store.auditEvents() }); return true; }
          if ((action === "approve" || action === "deny") && req.method === "POST") {
            const body = await readJson(req);
            if (typeof body?.id !== "string") throw error("Request ID required", 400);
            json(res, 200, store.decide(body.id, body.phrase, action === "approve")); return true;
          }
          if ((action === "lock" || action === "unlock") && req.method === "POST") {
            await readJson(req);
            const result = action === "lock" ? store.lock() : store.unlock();
            sweep(); json(res, 200, result); return true;
          }
          if (action === "devices" && req.method === "GET") { json(res, 200, { devices: store.list() }); return true; }
          if (action === "revoke" && req.method === "POST") {
            const body = await readJson(req);
            if (body?.all !== true && (typeof body?.id !== "string" || !body.id)) throw error("Device ID required", 400);
            const revoked = body.all === true ? store.revokeAll() : store.revoke(body.id);
            sweep(); json(res, 200, { revoked }); return true;
          }
          throw error("Unknown pairing operation", 404);
        }
        if (path === "/api/pairing/qr-exchange" && req.method === "POST") {
          const browser = originAllowed(req);
          if (!native && !browser) throw error("Cross-origin pairing denied", 403);
          const body = await readJson(req);
          const result = store.exchangeQr(body?.grant, body?.name);
          if (browser) json(res, 200, { device: result.device }, { "set-cookie": cookie(req, result.token) });
          else json(res, 200, result);
          return true;
        }
        if (path === "/api/pairing/exchange" && req.method === "POST") {
          if (!originAllowed(req)) throw error("Cross-origin pairing denied", 403);
          const body = await readJson(req);
          const result = store.exchange(body?.code, body?.name);
          json(res, 202, { request: result.request }, { "set-cookie": cookie(req, result.claimToken, 300, PENDING_COOKIE) }); return true;
        }
        if (path === "/api/pairing/poll" && req.method === "POST") {
          if (!originAllowed(req)) throw error("Cross-origin pairing denied", 403);
          const result = store.poll(tokenFrom(req, PENDING_COOKIE));
          if (result.device) json(res, 200, { device: result.device }, { "set-cookie": [cookie(req, result.token), cookie(req, "", 0, PENDING_COOKIE)] });
          else json(res, 200, { request: result.request });
          return true;
        }
        if (store.isLocked() && !local) {
          // Keep the non-sensitive landing page available to explain the lock.
          const document = ["/", "/web", "/app", "/app/", "/pair"].includes(path) && (req.headers.accept || "").includes("text/html");
          if (!document || req.method !== "GET") throw error("远程访问已锁定，请在电脑上解锁", 423);
        }
        // The old password/setup endpoints must not become an alternate bypass.
        if (path.startsWith("/api/web-auth/")) throw error("Use device pairing", 401);
        // 客户端错误上报刻意豁免配对:无法完成配对的浏览器/移动端恰恰是最
        // 需要记录报错的客户端。端点内有速率限制与体积上限,只写本地日志文件;
        // 锁定状态下已被上方 423 分支拦截,不会成为绕过锁定的通道。
        if (path === "/api/client-logs" && req.method === "POST") {
          req.headers["x-agentroam-device-id"] = local ? "desktop" : "client-logs";
          return false;
        }
        if (path === "/pair" || (!local && !test && !device && (!sdk || store.isLocked()))) {
          const document = (path === "/pair" || path === "/" || path === "/web" || path.startsWith("/web/") || path === "/app" || path.startsWith("/app/")) && (req.headers.accept || "").includes("text/html");
          if (req.method === "GET" && document) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; img-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
            res.end(PAIRING_PAGE); return true;
          }
          throw error("请先使用电脑上的配对码授权此设备");
        }
        if (!local && !sdk && !["GET", "HEAD"].includes(req.method) && !(native && bearer && device) && !originAllowed(req)) throw error("Cross-origin write denied", 403);
        // The outer gateway has verified the explicit device credential. Inner
        // same-origin guards must not mistake this native request for cookie CSRF.
        if (native && bearer && device) delete req.headers.origin;
        req.headers["x-agentroam-device-id"] = local ? "desktop" : test ? testId : sdk ? "sdk" : device.id;
        if (device && !local && Date.now() - device.seen >= 60_000) {
          store.renew(device.id);
          res.setHeader("set-cookie", cookie(req, token));
        }
        // Long-lived streams must stop when a device is revoked, too.
        if (!local) { streams.set(res, test ? testId : sdk ? "sdk" : device.id); res.once("close", () => streams.delete(res)); }
        const sensitiveRead = path.startsWith("/api/web-console/file-preview/");
        if (sensitiveRead || !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
          const category = sensitiveRead ? "file_preview" : ["settings", "agent", "sessions", "projects", "remote-tools", "web-console"].includes(path.split("/")[2]) ? path.split("/")[2] : "other";
          const action = `http.${category}`;
          const auth = { deviceId: local ? "desktop" : test ? testId : sdk ? "sdk" : device.id };
          auditOperation(auth, action, "started");
          res.once("finish", () => { try { auditOperation(auth, action, res.statusCode < 400 ? "success" : "failed"); } catch { console.error("Security audit completion could not be recorded"); } });
        }
        if (path === "/api/pairing/logout" && req.method === "POST" && device) {
          store.revoke(device.id, device.id);
          streams.delete(res);
          json(res, 200, { ok: true }, { "set-cookie": cookie(req, "", 0) }); sweep(); return true;
        }
        if (path === "/api/web-console/bootstrap" && req.method === "GET") {
          let wsNonce;
          if (local || test) {
            for (const [nonce, expires] of localNonces) if (expires <= Date.now()) localNonces.delete(nonce);
            wsNonce = randomBytes(32).toString("base64url"); localNonces.set(wsNonce, Date.now() + 60_000);
          } else {
            store.renew(device.id); wsNonce = store.issueNonce(device.id);
            res.setHeader("set-cookie", cookie(req, token));
          }
          const deviceId = local ? "desktop" : test ? testId : device.id;
          json(res, 200, { user: { id: owner.userId, username: owner.username }, deviceId, wsNonce, wsNonceExpiresAt: Date.now() + 60_000, tabs: consoleStore.listTabs(owner.userId), preferences: consoleStore.getPreferences(owner.userId), deviceState: consoleStore.getDeviceState(owner.userId, deviceId) }); return true;
        }
        return false;
      } catch (cause) { json(res, cause.status || 500, { error: cause.status ? cause.message : "Authentication service unavailable" }); return true; }
    },
    authenticateUpgrade(req) {
      if (!originAllowed(req)) return null;
      const nonce = new URL(req.url, "http://gateway.local").searchParams.get("nonce");
      if (desktop.authenticate(req)) {
        const expires = localNonces.get(nonce); localNonces.delete(nonce);
        return expires > Date.now() ? { ...owner, deviceId: "desktop", sessionId: null } : null;
      }
      // Explicit invalid desktop credentials never downgrade to a browser session.
      if (req.headers["x-agentroam-desktop-token"] || store.isLocked()) return null;
      if (testNoPairing) {
        const expires = localNonces.get(nonce); localNonces.delete(nonce);
        if (expires > Date.now()) return { ...owner, deviceId: testId, sessionId: testId };
      }
      const device = store.authenticate(tokenFrom(req));
      return device && store.consumeNonce(device.id, nonce) ? principal(device) : null;
    },
    track(ws, auth) { if (auth.sessionId) { sockets.set(ws, auth.sessionId); ws.once("close", () => sockets.delete(ws)); } },
    active(auth) { return !auth.sessionId || activeDevice(auth.sessionId); },
    close() { clearInterval(timer); for (const ws of sockets.keys()) ws.terminate(); for (const res of streams.keys()) res.destroy(); store.close(); },
  };
}
