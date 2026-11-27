import { constants, createHash, createPrivateKey, createPublicKey, privateDecrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { isIP } from "node:net";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);

const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/;
const streamPath = /^\/v1\/streams\/([a-f0-9]{32})$/;
const registrationTimeoutMs = 8_000;
const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

export function createRelay({ publicOrigin, privateKey, maxInstallations = 256, maxPerIp = 8, maxStreams = 64, streamTimeoutMs = 8_000, websocket = require("ws") }) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || origin.port || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash || !/^[a-z0-9.-]+$/.test(origin.hostname) || isIP(origin.hostname)) {
    throw new Error("PUBLIC_ORIGIN must be a public HTTPS origin on the default port");
  }
  if (!privateKey) throw new Error("Relay registration private key is required");
  const registrationKey = createPrivateKey(privateKey);
  const keyBits = registrationKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (registrationKey.asymmetricKeyType !== "rsa" || keyBits < 2048 || keyBits > 4096) {
    throw new Error("Relay registration requires a 2048–4096 bit RSA private key");
  }
  const publicKey = createPublicKey(registrationKey).export({ type: "spki", format: "der" }).toString("base64url");
  const proofLength = Math.ceil(Math.ceil(keyBits / 8) * 4 / 3);
  const root = origin.host;
  const clients = new Map();
  const pendingControls = new Map();
  const { WebSocketServer, createWebSocketStream } = websocket;
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

  function waitForStream(client, callback) {
    if (client.streams.size + client.pending.size >= maxStreams) {
      callback(new Error("Too many active streams"));
      return;
    }
    const id = randomBytes(16).toString("hex");
    const timeout = setTimeout(() => {
      client.pending.delete(id);
      callback(new Error("Desktop stream connection timed out"));
    }, streamTimeoutMs);
    client.pending.set(id, (socket) => {
      clearTimeout(timeout);
      client.pending.delete(id);
      if (!socket) callback(new Error("Desktop disconnected"));
      else callback(null, createWebSocketStream(socket));
    });
    client.socket.send(JSON.stringify({ type: "stream", id }), (error) => {
      if (error) client.pending.get(id)?.();
    });
  }

  function forward(req, response, head) {
    const host = req.headers.host?.toLowerCase();
    if (!head && host === root && req.method === "GET" && req.url === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"status":"pass"}');
      return;
    }
    const isUpgrade = head !== undefined;
    const client = clients.get(host);
    const fail = (status) => {
      if (isUpgrade) {
        if (!response.destroyed) response.end(`HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Bad Gateway"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } else if (!response.headersSent) {
        response.writeHead(status, { "cache-control": "no-store" }).end();
      } else response.destroy();
    };
    const pathname = req.url?.split("?")[0];
    if (!client || !pathname?.startsWith("/") || pathname.startsWith("//") || new URL(pathname, origin).pathname !== pathname ||
        (isUpgrade && req.headers.upgrade?.toLowerCase() !== "websocket") ||
        /^\/api\/(?:internal|desktop)(?:\/|$)/.test(pathname) || /%|\\/.test(pathname.split("/").slice(0, 3).join("/"))) {
      fail(404);
      return;
    }
    const upstream = request({
      createConnection: (_options, callback) => waitForStream(client, callback),
      host: "127.0.0.1", method: req.method, path: req.url, headers: proxyHeaders(req, isUpgrade),
    }, (incoming) => {
      if (isUpgrade) {
        incoming.destroy();
        fail(502);
        return;
      }
      response.writeHead(incoming.statusCode ?? 502, publicHeaders(incoming.headers));
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
    });
    upstream.once("error", () => fail(502));
    const timeout = setTimeout(() => upstream.destroy(new Error("Desktop response timed out")), 30_000);
    upstream.once("response", () => clearTimeout(timeout));
    upstream.once("close", () => clearTimeout(timeout));
    response.once("close", () => upstream.destroy());
    if (isUpgrade) {
      upstream.on("upgrade", (received, stream, firstChunk) => {
        clearTimeout(timeout);
        const values = { ...publicHeaders(received.headers), connection: "Upgrade", upgrade: "websocket" };
        const headers = Object.entries(values).flatMap(([name, value]) => [value].flat().map(item => name + ": " + item));
        response.write(["HTTP/1.1 101 Switching Protocols", ...headers, "", ""].join("\r\n"));
        if (firstChunk.length) response.write(firstChunk);
        if (head.length) stream.write(head);
        response.on("error", () => stream.destroy());
        stream.on("error", () => response.destroy());
        stream.once("close", () => response.destroy());
        stream.pipe(response).pipe(stream);
      });
      upstream.end();
    } else req.pipe(upstream);
  }

  const server = createServer((req, res) => forward(req, res));

  function verifiesRegistration(data, token, nonce) {
    if (data.length > proofLength + 64) return false;
    try {
      const { type, proof } = JSON.parse(data.toString());
      if (type !== "proof" || typeof proof !== "string" || proof.length !== proofLength || !/^[A-Za-z0-9_-]+$/.test(proof)) return false;
      const received = privateDecrypt({
        key: registrationKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256",
      }, Buffer.from(proof, "base64url"));
      const expected = Buffer.from(JSON.stringify(["agentroam", "https-relay-v1", token, nonce]));
      return received.length === expected.length && timingSafeEqual(received, expected);
    } catch {
      return false;
    }
  }

  server.on("upgrade", (req, socket, head) => {
    const host = req.headers.host?.toLowerCase();
    if (host !== root) {
      forward(req, socket, head);
      return;
    }
    const token = bearer.exec(req.headers.authorization)?.[1];
    const route = token && `d-${createHash("sha256").update(token).digest("hex").slice(0, 32)}.${root}`;
    const existing = clients.get(route);
    const streamId = streamPath.exec(req.url)?.[1];
    if (streamId && existing?.pending.has(streamId)) {
      ws.handleUpgrade(req, socket, head, (stream) => {
        existing.streams.add(stream);
        stream.on("error", () => {});
        stream.once("close", () => existing.streams.delete(stream));
        existing.pending.get(streamId)(stream);
      });
      return;
    }
    const ip = sourceIp(req);
    if (req.url !== "/v1/connect" || !route || req.headers.origin || existing ||
        clients.size + pendingControls.size >= maxInstallations ||
        [...clients.values()].filter(client => client.ip === ip).length + [...pendingControls.values()].filter(peer => peer === ip).length >= maxPerIp) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    ws.handleUpgrade(req, socket, head, (control) => {
      const nonce = randomBytes(32).toString("base64url");
      const timer = setTimeout(() => control.terminate(), registrationTimeoutMs);
      pendingControls.set(control, ip);
      const clearPending = () => {
        clearTimeout(timer);
        pendingControls.delete(control);
      };
      control.on("error", () => {});
      control.once("close", clearPending);
      control.once("message", (data) => {
        if (clients.has(route) || !verifiesRegistration(data, token, nonce)) {
          control.terminate();
          return;
        }
        clearPending();
        const client = { socket: control, ip, pending: new Map(), streams: new Set(), responsive: true };
        clients.set(route, client);
        control.on("pong", () => { client.responsive = true; });
        control.once("close", () => {
          clients.delete(route);
          for (const deliver of client.pending.values()) deliver();
          for (const stream of client.streams) stream.terminate();
        });
        control.send(JSON.stringify({ type: "ready", publicUrl: `https://${route}` }));
      });
      control.send(JSON.stringify({ type: "challenge", nonce, publicKey }));
    });
  });
  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.responsive) client.socket.terminate();
      else { client.responsive = false; client.socket.ping(); }
    }
  }, 15_000);
  heartbeat.unref();
  server.once("close", () => clearInterval(heartbeat));
  return { server, close() {
    for (const control of pendingControls.keys()) control.terminate();
    for (const client of clients.values()) client.socket.terminate();
    server.close();
  } };
}

function filterHopHeaders(headers) {
  const blocked = new Set(String(headers.connection ?? "").toLowerCase().split(",").map(name => name.trim()));
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !hopHeaders.has(name) && !blocked.has(name)));
}

// Browsers enforce the __Host- prefix even when sibling relay domains serve
// different applications. Keep those domains from planting a shared cookie.
function publicHeaders(upstream) {
  const headers = filterHopHeaders(upstream);
  delete headers["clear-site-data"];
  if (headers["set-cookie"]) {
    headers["set-cookie"] = headers["set-cookie"].map(cookie =>
      "__Host-" + cookie.replace(/;\s*(?:domain|path|secure)\b[^;]*/ig, "") + "; Path=/; Secure");
  }
  return headers;
}

function proxyHeaders(req, upgrade) {
  const headers = filterHopHeaders(req.headers);
  const upgradeHeaders = !upgrade ? {} : { connection: "Upgrade", upgrade: "websocket" };
  for (const name of Object.keys(headers)) {
    if (name.startsWith("x-forwarded-") || name === "forwarded" || name === "x-agentroam-desktop-token" ||
        name === "cf-connecting-ip" || name === "x-real-ip") delete headers[name];
  }
  if (headers.cookie) {
    const cookies = headers.cookie.split(";").map(value => value.trim())
      .filter(cookie => /^__Host-[^=]+=/.test(cookie)).map(cookie => cookie.slice(7));
    if (cookies.length) headers.cookie = cookies.join("; ");
    else delete headers.cookie;
  }
  return {
    ...headers, ...upgradeHeaders, host: req.headers.host, "x-forwarded-host": req.headers.host,
    "x-forwarded-proto": "https", "x-forwarded-for": sourceIp(req),
  };
}

function sourceIp(req) {
  const peer = req.socket.remoteAddress;
  const received = String(req.headers["x-real-ip"] ?? "");
  return (peer === "127.0.0.1" || peer === "::1") && isIP(received) ? received : peer ?? "unknown";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const keyFile = process.env.RELAY_PRIVATE_KEY_FILE?.trim();
  if (!keyFile) throw new Error("Set RELAY_PRIVATE_KEY_FILE to the relay registration private key");
  const relay = createRelay({ publicOrigin: process.env.PUBLIC_ORIGIN, privateKey: readFileSync(keyFile) });
  relay.server.listen(Number(process.env.PORT || 18082), "127.0.0.1");
  process.once("SIGTERM", () => relay.close());
  process.once("SIGINT", () => relay.close());
}
