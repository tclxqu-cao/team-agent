import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { DevicePairingStore, DEVICE_SESSION_MS } from "./device-pairing-store.mjs";
import { createDevicePairingGateway } from "./device-pairing-gateway.mjs";
import { createDesktopDiscovery } from "./desktop-discovery.mjs";
import { pairingAdmin } from "../../cli/src/device-pairing";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentroam-pairing-"));
  let now = Date.now();
  const store = new DevicePairingStore(dir, () => now);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, advance(ms: number) { now += ms; } };
}

function authorize(store: DevicePairingStore, name: string) {
  const pending = store.exchange(store.createCode().code, name);
  store.decide(pending.request.id, pending.request.phrase, true);
  return store.poll(pending.claimToken);
}

describe("device pairing storage", () => {
  it("issues independent devices, keeps only hashes, rejects replay and preserves sessions across reopen", () => {
    const f = fixture();
    const { code } = f.store.createCode();
    const pending = f.store.exchange(code, "Phone A");
    expect(f.store.poll(pending.claimToken).request.status).toBe("waiting");
    expect(f.store.list()).toEqual([]);
    f.store.decide(pending.request.id, pending.request.phrase, true);
    const a = f.store.poll(pending.claimToken);
    expect(() => f.store.exchange(code, "Replay")).toThrow();
    const b = authorize(f.store, "Phone B");
    expect(a.device.id).not.toBe(b.device.id);
    expect(f.store.authenticate(a.token)?.name).toBe("Phone A");
    const other = new DevicePairingStore(f.dir);
    try { expect(other.authenticate(b.token)?.name).toBe("Phone B"); } finally { other.close(); }
    const stored = readFileSync(join(f.dir, ".agentroam-auth/devices.sqlite")).toString("latin1");
    expect(stored).not.toContain(a.token); expect(stored).not.toContain(b.token);
  });
  it("expires codes at five minutes and locks the code globally after five failed guesses", () => {
    const f = fixture(); const { code } = f.store.createCode();
    for (let n = 0; n < 5; n++) expect(() => f.store.exchange("invalid", "bad")).toThrow();
    expect(() => f.store.exchange(code, "good")).toThrow(/次数/);
    const fresh = f.store.createCode(); f.advance(5 * 60_000);
    expect(() => f.store.exchange(fresh.code, "late")).toThrow(/过期/);
  });
  it("binds one-time nonces to devices and revokes one device without affecting another", () => {
    const f = fixture();
    const a = authorize(f.store, "A");
    const b = authorize(f.store, "B");
    const nonce = f.store.issueNonce(a.device.id);
    expect(f.store.consumeNonce(b.device.id, nonce)).toBe(false);
    expect(f.store.consumeNonce(a.device.id, nonce)).toBe(true);
    expect(f.store.consumeNonce(a.device.id, nonce)).toBe(false);
    f.store.revoke(a.device.id);
    expect(f.store.authenticate(a.token)).toBeNull();
    expect(f.store.authenticate(b.token)).not.toBeNull();
    f.store.revokeAll(); expect(f.store.list()).toEqual([]);
  });
  it("expires sessions and extends only an active device", () => {
    const f = fixture(); const a = authorize(f.store, "A");
    f.advance(DEVICE_SESSION_MS - 1); f.store.renew(a.device.id); f.advance(2);
    expect(f.store.authenticate(a.token)).not.toBeNull();
    f.advance(DEVICE_SESSION_MS); f.store.renew(a.device.id);
    expect(f.store.authenticate(a.token)).toBeNull();
  });
});

async function serverFixture(sdkToken?: string, testNoPairing = false) {
  const dir = mkdtempSync(join(tmpdir(), "agentroam-pair-http-"));
  const dataDir = join(dir, "data");
  const registry = join(dir, "services");
  const desktop = createDesktopDiscovery({ dataDir, directory: registry });
  const auth = createDevicePairingGateway({ dataDir, desktop, owner: { userId: "existing-owner", username: "local" }, consoleStore: { listTabs: () => [{ id: "existing-tab" }], getPreferences: () => ({}), getDeviceState: (_user: string, device: string) => ({ deviceId: device }) }, trustProxy: true, sdkToken, testNoPairing });
  const http = createServer((req, res) => {
    if (desktop.handle(req, res)) return;
    void auth.handle(req, res).then((handled) => {
      if (!handled) {
        if (req.url === "/api/agent/stream?live=1") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: ready\n\n"); return; }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ authorized: true, deviceId: req.headers["x-agentroam-device-id"], url: req.url }));
      }
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const principal = auth.authenticateUpgrade(req);
    if (!principal) { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { auth.track(ws, principal); });
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const port = (http.address() as { port: number }).port;
  await desktop.publish(port);
  const origin = `http://127.0.0.1:${port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(origin + path, init);
  const pair = async (name: string) => {
    const { code } = await pairingAdmin<{ code: string }>(dir, "code", {}, { registry });
    const response = await request("/api/pairing/exchange", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
    expect(response.status).toBe(202);
    const pendingCookie = response.headers.get("set-cookie")!.split(";")[0];
    const { request: pending } = await response.json();
    expect((await request("/api/settings", { headers: { cookie: pendingCookie } })).status).toBe(401);
    await pairingAdmin(dir, "approve", { id: pending.id, phrase: pending.phrase }, { registry });
    const claimed = await request("/api/pairing/poll", { method: "POST", headers: { origin, cookie: pendingCookie } });
    expect(claimed.status).toBe(200);
    return { cookie: claimed.headers.getSetCookie()[0].split(";")[0], device: (await claimed.json()).device, code };
  };
  cleanups.push(async () => { auth.close(); wss.close(); http.closeAllConnections(); await new Promise<void>((r) => http.close(() => r())); await desktop.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, auth, request, origin, pair, registry, desktop };
}

describe("gateway pairing integration", () => {
  it("protects every business path, files, bootstrap and old login routes; serves only a pairing page", async () => {
    const f = await serverFixture();
    for (const path of ["/api/settings", "/api/sessions", "/api/web-console/bootstrap", "/api/web-console/file-preview/ticket", "/api/web-auth/setup", "/api/pairing/admin/devices"]) {
      expect((await f.request(path)).status, path).toBe(401);
    }
    const response = await f.request("/web", { headers: { accept: "text/html" } });
    expect(response.status).toBe(200); expect(await response.text()).toContain("配对并进入");
    expect(await (await f.request("/api/web-auth/status")).json()).toMatchObject({ authenticated: false, needsSetup: false });
    expect((await f.request("/api/settings", { headers: { "x-agentroam-device-id": "forged", "x-forwarded-for": "127.0.0.1" } })).status).toBe(401);
  });
  it("allows two devices sharing history with isolated device state, denies CSRF and untrusted admin calls", async () => {
    const f = await serverFixture(); const a = await f.pair("A"); const b = await f.pair("B");
    for (const device of [a, b]) {
      const bootstrap = await (await f.request("/api/web-console/bootstrap", { headers: { cookie: device.cookie } })).json();
      expect(bootstrap.user.id).toBe("existing-owner"); expect(bootstrap.deviceId).toBe(device.device.id);
      expect(bootstrap.tabs).toEqual([{ id: "existing-tab" }]);
    }
    const write = { method: "POST", headers: { cookie: a.cookie, "content-type": "application/json" }, body: "{}" };
    expect((await f.request("/api/settings", write)).status).toBe(403);
    expect((await f.request("/api/settings", { ...write, headers: { ...write.headers, origin: "https://evil.test" } })).status).toBe(403);
    expect((await f.request("/api/settings", { ...write, headers: { ...write.headers, origin: f.origin } })).status).toBe(200);
    expect((await f.request("/api/pairing/admin/code", { ...write, headers: { ...write.headers, origin: f.origin } })).status).toBe(401);
    const settings = await f.request("/api/settings", { headers: { cookie: a.cookie, "x-agentroam-device-id": b.device.id } });
    expect((await settings.json()).deviceId).toBe(a.device.id);
    const replay = await f.request("/api/pairing/exchange", { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: JSON.stringify({ code: b.code, name: "C" }) });
    expect(replay.status).toBe(401);
  });
  it("rejects stolen nonces and disconnects revoked sockets while retaining the second phone", async () => {
    const f = await serverFixture(); const a = await f.pair("A"); const b = await f.pair("B");
    const bootstrap = await (await f.request("/api/web-console/bootstrap", { headers: { cookie: a.cookie } })).json();
    const wsUrl = f.origin.replace("http:", "ws:") + "/ws?nonce=" + bootstrap.wsNonce;
    const stolen = new WebSocket(wsUrl, { headers: { origin: f.origin, cookie: b.cookie } });
    await once(stolen, "error");
    const ws = new WebSocket(wsUrl, { headers: { origin: f.origin, cookie: a.cookie } }); await once(ws, "open");
    const closed = once(ws, "close");
    await pairingAdmin(f.dir, "revoke", { id: a.device.id }, { registry: f.registry }); await closed;
    expect((await f.request("/api/settings", { headers: { cookie: a.cookie } })).status).toBe(401);
    expect((await f.request("/api/settings", { headers: { cookie: b.cookie } })).status).toBe(200);
    const { devices } = await pairingAdmin<{ devices: { id: string }[] }>(f.dir, "devices", undefined, { registry: f.registry });
    expect(devices.map((d) => d.id)).toEqual([b.device.id]);
  });
  it("keeps explicitly configured SDK credentials scoped away from desktop control", async () => {
    const f = await serverFixture("configured-sdk-secret");
    expect((await f.request("/api/sessions", { headers: { authorization: "Bearer configured-sdk-secret" } })).status).toBe(200);
    const stream = await f.request("/api/agent/stream?token=configured-sdk-secret");
    expect(stream.status).toBe(200);
    expect((await stream.json()).url).toBe("/api/agent/stream");
    expect((await f.request("/api/sessions", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    for (const path of ["/api/settings", "/api/web-console/bootstrap", "/api/pairing/admin/devices"]) expect((await f.request(path, { headers: { authorization: "Bearer configured-sdk-secret" } })).status).toBe(401);
  });
  it("sets HttpOnly/SameSite and trusted HTTPS Secure cookies and rejects cross-origin pairing", async () => {
    const f = await serverFixture();
    const { code } = f.auth.store.createCode();
    const init = { method: "POST", headers: { "content-type": "application/json", origin: "https://phone.example", "x-forwarded-host": "phone.example", "x-forwarded-proto": "https" }, body: JSON.stringify({ code, name: "Secure phone" }) };
    expect((await f.request("/api/pairing/exchange", { ...init, headers: { ...init.headers, origin: "https://evil.example" } })).status).toBe(403);
    const res = await f.request("/api/pairing/exchange", init);
    expect(res.status).toBe(202);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Max-Age=300; Secure");
    const body = await res.json(); expect(body).not.toHaveProperty("token");
    f.auth.store.decide(body.request.id, body.request.phrase, true);
    const claimed = await f.request("/api/pairing/poll", { method: "POST", headers: { ...init.headers, cookie: res.headers.get("set-cookie")!.split(";")[0] } });
    expect(claimed.headers.getSetCookie()[0]).toContain("HttpOnly; SameSite=Strict; Max-Age=2592000; Secure");
  });
  it("preserves trusted desktop access and fails closed on stale local credentials", async () => {
    const f = await serverFixture();
    // Source-checkout gateways use the base directory directly, while installed CLI uses its data/ child.
    expect(await pairingAdmin(join(f.dir, "data"), "devices", undefined, { registry: f.registry })).toEqual({ devices: [] });
    expect((await f.request("/api/settings", { headers: f.desktop.headers() })).status).toBe(200);
    const a = await f.pair("A");
    expect((await f.request("/api/settings", { headers: { cookie: a.cookie, "x-agentroam-desktop-token": "invalid" } })).status).toBe(401);
    const b = await (await f.request("/api/web-console/bootstrap", { headers: f.desktop.headers() })).json();
    const ws = new WebSocket(f.origin.replace("http:", "ws:") + "/ws?nonce=" + b.wsNonce, { headers: { origin: f.origin, ...f.desktop.headers() } });
    await once(ws, "open"); ws.close(); await once(ws, "close");
  });
});

describe("local approval and emergency lock", () => {
  it("PWA redeems same-origin QR into HttpOnly cookie without exposing the device token", async () => {
    const f = await serverFixture(); const { grant } = f.auth.store.createQr();
    const headers = { origin: f.origin, "content-type": "application/json" };
    const res = await f.request("/api/pairing/qr-exchange", { method: "POST", headers, body: JSON.stringify({ grant }) });
    expect(res.status).toBe(200); expect(await res.json()).not.toHaveProperty("token");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    expect((await f.request("/api/settings", { headers: { cookie } })).status).toBe(200);
    expect((await f.request("/api/pairing/qr-exchange", { method: "POST", headers, body: JSON.stringify({ grant }) })).status).toBe(410);
    const page = await f.request("/pair", { headers: { accept: "text/html", cookie } });
    expect(await page.text()).toContain("扫码直接连接");
    f.auth.store.lock();
    for (const path of ["/manifest.webmanifest", "/service-worker.js", "/pwa/icon-192.png", "/pwa/offline.html", "/pwa/qr-decoder.js"]) expect((await f.request(path)).status).toBe(200);
    expect((await f.request("/pwa/devices.sqlite")).status).toBe(423);
    expect((await f.request("/api/settings", { headers: { cookie } })).status).toBe(423);
  });
  it("QR grants directly authorize once, expire, replace and are cancelled by lock", () => {
    const f = fixture();
    const old = f.store.createQr(); const current = f.store.createQr();
    expect(() => f.store.exchangeQr(old.grant, "old")).toThrow();
    const device = f.store.exchangeQr(current.grant, "App");
    expect(f.store.authenticate(device.token)?.id).toBe(device.device.id);
    expect(f.store.pending()).toEqual([]);
    expect(() => f.store.exchangeQr(current.grant, "replay")).toThrow();
    const expires = f.store.createQr(); f.advance(300_000);
    expect(() => f.store.exchangeQr(expires.grant, "late")).toThrow();
    const locked = f.store.createQr(); f.store.lock(); f.store.unlock();
    expect(() => f.store.exchangeQr(locked.grant, "locked")).toThrow();
    expect(f.store.authenticate(device.token)).toBeNull();
    expect(JSON.stringify(f.store.auditEvents())).not.toContain(current.grant);
    expect(JSON.stringify(f.store.auditEvents())).not.toContain(device.token);
  });
  it("allows native QR exchange and bearer writes but never native-origin-only access or admin", async () => {
    const f = await serverFixture(); const native = "capacitor://localhost";
    const grant = await pairingAdmin<{ grant: string }>(f.dir, "qr", {}, { registry: f.registry });
    const preflight = await f.request("/api/pairing/qr-exchange", { method: "OPTIONS", headers: { origin: native, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(preflight.status).toBe(204); expect(preflight.headers.get("access-control-allow-origin")).toBe(native);
    const body = JSON.stringify({ grant: grant.grant, name: "App" });
    expect((await f.request("/api/pairing/qr-exchange", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body })).status).toBe(403);
    expect((await f.request("/api/settings", { headers: { origin: native } })).status).toBe(401);
    const response = await f.request("/api/pairing/qr-exchange", { method: "POST", headers: { origin: native, "content-type": "application/json" }, body });
    expect(response.status).toBe(200); const { token } = await response.json();
    for (const origin of [native, "https://localhost"]) {
      const headers = { origin, authorization: `Bearer ${token}`, "content-type": "application/json" };
      expect((await f.request("/api/settings", { method: "POST", headers, body: "{}" })).status).toBe(200);
      expect((await f.request("/api/pairing/admin/qr", { method: "POST", headers, body: "{}" })).status).toBe(401);
    }
    await pairingAdmin(f.dir, "lock", {}, { registry: f.registry });
    expect((await f.request("/api/settings", { headers: { origin: native, authorization: `Bearer ${token}` } })).status).toBe(423);
  });
  it("terminates an already open SDK event stream on emergency lock", async () => {
    const f = await serverFixture("sdk-stream-secret");
    const response = await f.request("/api/agent/stream?live=1&token=sdk-stream-secret");
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const ended = reader.read().then((result) => result.done, () => true);
    await pairingAdmin(f.dir, "lock", undefined, { registry: f.registry });
    expect(await ended).toBe(true);
  });
  it("requires approval with the matching phrase, issues only to the originating claimant, and cannot replay", () => {
    const f = fixture(); const { code } = f.store.createCode();
    const a = f.store.exchange(code, "A");
    expect(a).not.toHaveProperty("token");
    expect(f.store.authenticate(a.claimToken)).toBeNull();
    expect(f.store.poll(a.claimToken).request.status).toBe("waiting");
    expect(() => f.store.decide(a.request.id, "wrong", true)).toThrow(/短语/);
    expect(f.store.list()).toEqual([]);
    f.store.decide(a.request.id, a.request.phrase, true);
    expect(f.store.list()).toEqual([]);
    expect(() => f.store.poll("another-browser")).toThrow();
    const device = f.store.poll(a.claimToken);
    expect(f.store.authenticate(device.token)).not.toBeNull();
    expect(() => f.store.poll(a.claimToken)).toThrow();
  });
  it("denies and expires requests without issuing a session, including approved but unclaimed requests", () => {
    const f = fixture(); const a = f.store.exchange(f.store.createCode().code, "A");
    f.store.decide(a.request.id, undefined, false);
    expect(f.store.poll(a.claimToken).request.status).toBe("denied");
    const b = f.store.exchange(f.store.createCode().code, "B");
    f.store.decide(b.request.id, b.request.phrase, true);
    const c = f.store.exchange(f.store.createCode().code, "C");
    f.advance(300_000);
    expect(() => f.store.decide(c.request.id, c.request.phrase, true)).toThrow();
    expect(() => f.store.poll(b.claimToken)).toThrow();
    expect(f.store.pending()).toEqual([]); expect(f.store.list()).toEqual([]);
    expect(f.store.auditEvents().some((e) => e.action === "pair.expired")).toBe(true);
  });
  it("persists lock across restart and cancels pending approvals, codes and all old devices", () => {
    const f = fixture(); const a = authorize(f.store, "A");
    const waiting = f.store.exchange(f.store.createCode().code, "B");
    f.store.decide(waiting.request.id, waiting.request.phrase, true);
    const code = f.store.createCode().code;
    const nonce = f.store.issueNonce(a.device.id);
    f.store.lock();
    expect(f.store.authenticate(a.token)).toBeNull();
    expect(f.store.consumeNonce(a.device.id, nonce)).toBe(false);
    expect(() => f.store.createCode()).toThrow(/锁定/);
    expect(() => f.store.exchange(code, "C")).toThrow(/锁定/);
    expect(() => f.store.poll(waiting.claimToken)).toThrow(/锁定/);
    const reopened = new DevicePairingStore(f.dir);
    try { expect(reopened.isLocked()).toBe(true); reopened.unlock(); } finally { reopened.close(); }
    expect(f.store.isLocked()).toBe(false);
    expect(() => f.store.exchange(code, "C")).toThrow();
    expect(() => f.store.poll(waiting.claimToken)).toThrow();
    expect(f.store.authenticate(a.token)).toBeNull();
  });
  it("forbids browser approval/unlock and stops live sockets and SDK access on lock", async () => {
    const f = await serverFixture("sdk-test"); const a = await f.pair("A");
    const { wsNonce } = await (await f.request("/api/web-console/bootstrap", { headers: { cookie: a.cookie } })).json();
    const ws = new WebSocket(f.origin.replace("http:", "ws:") + "/ws?nonce=" + wsNonce, { headers: { origin: f.origin, cookie: a.cookie } });
    await once(ws, "open");
    for (const action of ["approve", "deny", "lock", "unlock", "audit", "requests"]) {
      expect((await f.request(`/api/pairing/admin/${action}`, { method: "POST", headers: { origin: f.origin, cookie: a.cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    }
    const closed = once(ws, "close");
    await pairingAdmin(f.dir, "lock", undefined, { registry: f.registry }); await closed;
    expect((await f.request("/api/settings", { headers: { cookie: a.cookie } })).status).toBe(423);
    expect((await f.request("/api/sessions", { headers: { authorization: "Bearer sdk-test" } })).status).toBe(423);
    expect((await f.request("/api/settings", { headers: f.desktop.headers() })).status).toBe(200);
    await pairingAdmin(f.dir, "unlock", undefined, { registry: f.registry });
    expect((await f.request("/api/settings", { headers: { cookie: a.cookie } })).status).toBe(401);
  });
  it("audits sensitive outcomes without request bodies, query strings, names or credentials", async () => {
    const f = await serverFixture(); const a = await f.pair("name-secret-canary");
    await f.request("/api/settings?token=query-secret-canary", { method: "POST", headers: { cookie: a.cookie, origin: f.origin, "content-type": "application/json" }, body: JSON.stringify({ apiKey: "body-secret-canary" }) });
    f.auth.auditOperation({ deviceId: a.device.id }, "ws.term:input", "started");
    f.auth.auditOperation({ deviceId: a.device.id }, "ws.term:input", "started");
    await pairingAdmin(f.dir, "lock", undefined, { registry: f.registry });
    const { events } = await pairingAdmin<{ events: { action: string; outcome: string }[] }>(f.dir, "audit", undefined, { registry: f.registry });
    expect(events.some((e) => e.action === "http.settings" && e.outcome === "success")).toBe(true);
    expect(events.filter((e) => e.action === "ws.term:input")).toHaveLength(1);
    for (const action of ["pair.requested", "pair.approved", "device.authorized", "remote.locked", "devices.revoked_all"]) expect(events.some((e) => e.action === action)).toBe(true);
    const audit = JSON.stringify(events);
    for (const value of [a.cookie, a.code, "name-secret-canary", "query-secret-canary", "body-secret-canary"]) expect(audit).not.toContain(value);
  });
});


describe("explicit test startup", () => {
  it("allows HTTP and nonce WebSockets without persistent credentials, preserves admin and lock gates", async () => {
    const f = await serverFixture(undefined, true);
    expect(await (await f.request("/api/web-auth/status")).json()).toMatchObject({ authenticated: true, pairingRequired: false });
    const r = await f.request("/api/settings");
    expect(r.status).toBe(200); expect(r.headers.get("set-cookie")).toBeNull();
    expect(f.auth.store.list()).toEqual([]);
    expect((await f.request("/api/pairing/admin/devices")).status).toBe(401);
    expect((await f.request("/api/settings", { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
    const b = await (await f.request("/api/web-console/bootstrap")).json();
    const ws = new WebSocket(f.origin.replace("http:", "ws:") + "/ws?nonce=" + b.wsNonce, { headers: { origin: f.origin } });
    await once(ws, "open");
    const closed = once(ws, "close");
    await pairingAdmin(f.dir, "lock", {}, { registry: f.registry });
    await closed;
    expect((await f.request("/api/settings")).status).toBe(423);
    expect(await (await f.request("/api/web-auth/status")).json()).toMatchObject({ authenticated: false, locked: true });
  });
});
