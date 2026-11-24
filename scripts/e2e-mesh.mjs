#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, fork, spawn } from "node:child_process";
import { once } from "node:events";
import { open, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { attachMeshControl, createMeshRuntime } from "../packages/cli/dist/mesh/mesh-runtime.js";
import { pairingQrPayload } from "../packages/cli/dist/device-pairing.js";
import { localServiceRequest } from "../packages/cli/dist/local-service-request.js";
import { detectPlatform } from "../packages/cli/dist/platform.js";
import { readTailscaleStatus, tailscaleUp } from "../packages/cli/dist/tailscale/tailnet-cli.js";
import { createHeadscaleClient } from "../packages/server/lib/mesh/headscale-client.mjs";

const exec = promisify(execFile);
const require = createRequire(new URL("../packages/server/package.json", import.meta.url));
const WebSocket = require("ws");
const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "agentroam-mesh-e2e-"));
const gateway = process.env.MESH_E2E_GATEWAY || fileURLToPath(new URL("../packages/server/ws-server.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../packages/cli/bin/agentroam.mjs", import.meta.url));
const policy = fileURLToPath(new URL("../deploy/headscale/policy.hujson", import.meta.url));
const headscale = process.env.MESH_E2E_HEADSCALE || "headscale";
const bin = process.env.MESH_E2E_TAILSCALE_BIN || "";
if (bin) process.env.PATH = [bin, process.env.PATH].join(delimiter);
const discovery = join(root, "services");
process.env.AGENTROAM_DISCOVERY_DIR = discovery;
const dataDir = join(root, "desktop");
const hosts = new Set();
let desktop;
let failed = false;

async function freePort() {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function waitFor(description, probe, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  do {
    try {
      const value = await probe();
      if (value) return value;
    } catch { /* Probe while the process converges. */ }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function runServer(file, args, name, options = {}) {
  const logfile = await open(join(root, `${name}.log`), "a", 0o600);
  try {
    const stdio = ["ignore", logfile.fd, logfile.fd];
    const processHandle = options.ipc
      ? fork(file, args, { ...options, stdio: [...stdio, "ipc"] })
      : spawn(file, args, { ...options, stdio });
    hosts.add(processHandle);
    processHandle.on("error", () => {});
    return processHandle;
  } finally { await logfile.close(); }
}

async function stop(processHandle) {
  if (!processHandle?.pid || processHandle.exitCode !== null || processHandle.signalCode !== null) return;
  try {
    const exited = once(processHandle, "exit", { signal: AbortSignal.timeout(8_000) });
    processHandle.kill("SIGTERM");
    await exited;
  } catch { processHandle.kill("SIGKILL"); }
}

async function throughPeer(port, url, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(url);
  return await new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, method, path: target.href,
      headers: { host: target.host, ...headers }, signal: AbortSignal.timeout(15_000),
    }, res => {
      const chunks = [];
      res.on("data", part => chunks.push(part));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function webSocketHello(port, origin, nonce, deviceId) {
  const { host } = new URL(origin);
  const socket = await new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, path: `${host}:80`, method: "CONNECT",
      signal: AbortSignal.timeout(10_000),
    });
    req.on("error", reject);
    req.on("connect", (res, tunnel, head) => {
      if (res.statusCode !== 200) { tunnel.destroy(); reject(new Error(`CONNECT failed: ${res.statusCode}`)); return; }
      if (head.length) tunnel.unshift(head);
      resolve(tunnel);
    });
    req.end();
  });
  const ws = new WebSocket(`ws://${host}/ws?nonce=${nonce}`, {
    origin: "http://localhost", createConnection: () => socket, handshakeTimeout: 10_000,
  });
  try {
    const [message] = await once(ws, "message", { signal: AbortSignal.timeout(10_000) });
    assert.deepEqual(JSON.parse(message).type, "connection:hello");
    assert.equal(JSON.parse(message).deviceId, deviceId);
  } finally { ws.terminate(); socket.destroy(); }
}

const local = (path, body) => localServiceRequest(dataDir, path, body === undefined ? {} : { method: "POST", body });
const cliCommand = (action) => exec(process.execPath, [cli, "mesh", action, "--data-dir", dataDir, "--no-qr"], { timeout: 130_000 });
try {
  const controlPort = await freePort();
  const loginServer = `http://127.0.0.1:${controlPort}`;
  const config = join(root, "headscale.yaml");
  await writeFile(config, JSON.stringify({
    server_url: loginServer, listen_addr: `127.0.0.1:${controlPort}`,
    grpc_listen_addr: `127.0.0.1:${await freePort()}`, metrics_listen_addr: `127.0.0.1:${await freePort()}`,
    unix_socket: join(root, "headscale.sock"), noise: { private_key_path: join(root, "noise.key") },
    prefixes: { v4: "100.64.0.0/10", allocation: "sequential" },
    derp: { server: { enabled: false }, urls: ["https://controlplane.tailscale.com/derpmap/default"], auto_update_enabled: false },
    database: { type: "sqlite", sqlite: { path: join(root, "headscale.db"), write_ahead_log: true } },
    dns: { magic_dns: true, base_domain: "mesh.test", override_local_dns: false, nameservers: { global: ["1.1.1.1"] } },
    policy: { mode: "file", path: policy }, disable_check_updates: true,
  }));
  await runServer(headscale, ["--config", config, "serve"], "headscale");
  await waitFor("Headscale health", async () => (await fetch(`${loginServer}/health`)).ok);
  const apiKey = (await exec(headscale, ["--config", config, "apikeys", "create"])).stdout.trim();
  const control = createHeadscaleClient({ baseUrl: loginServer, apiKey });
  const runDesktop = async () => {
    const port = await freePort();
    const localUrl = `http://127.0.0.1:${port}`;
    const runtime = createMeshRuntime({ dataDir, localUrl, target: detectPlatform() });
    const child = await runServer(gateway, [], "agentroam", {
      cwd: dirname(gateway), ipc: true, env: {
        ...process.env, PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "production", NEXT_DIST_DIR: ".next",
        AGENT_DATA_DIR: join(dataDir, "data"), AGENT_WEB_ROOTS: root, AGENT_TRUST_TUNNEL_PROXY: "1",
        AGENT_HEADSCALE_URL: loginServer, AGENT_HEADSCALE_API_KEY: apiKey,
      },
    });
    const detach = attachMeshControl(child, runtime);
    desktop = { runtime, child, detach };
    await waitFor("AgentRoam gateway", async () => (await local("/api/mesh/status")).configured);
    await runtime.run("onboard", "mesh-e2e-desktop", true);
    return await local("/api/mesh/status");
  };
  const stopDesktop = async () => {
    desktop.detach();
    await desktop.runtime.close();
    await stop(desktop.child);
    desktop = null;
  };

  const initial = await runDesktop();
  assert.equal(initial.phase, "joined");
  assert.match(initial.tailnetIPv4, /^100\./);
  assert.ok(initial.dnsName);
  const origin = `http://${initial.dnsName}`;
  const originalNode = (await control.listNodes()).find(node => node.ipAddresses.includes(initial.tailnetIPv4));
  assert.ok(originalNode);
  console.log("PASS desktop onboard: real Headscale node registered and AgentRoam marks it joined");

  const issued = await local("/api/mesh/admin/key", { device: "phone", nodeName: "mesh-e2e-phone" });
  assert.equal(issued.accessUrl, origin);
  assert.equal(issued.user, originalNode.user);

  const startPeer = async name => {
    const stateDir = join(root, name);
    await mkdir(stateDir, { mode: 0o700 });
    const sock = join(stateDir, "ts.sock");
    const proxyPort = await freePort();
    const tailscalePath = bin ? join(bin, "tailscale") : "tailscale";
    await runServer(bin ? join(bin, "tailscaled") : "tailscaled",
      ["--tun=userspace-networking", "--port=0", `--statedir=${stateDir}`, `--socket=${sock}`,
        `--outbound-http-proxy-listen=127.0.0.1:${proxyPort}`], name);
    const cliOptions = { tailscalePath, socketPath: sock };
    await waitFor(`${name} daemon`, async () => (await readTailscaleStatus(cliOptions)).backendState === "NeedsLogin");
    return { cliOptions, proxyPort, stateDir };
  };
  const phone = await startPeer("phone");
  await tailscaleUp(phone.cliOptions, { loginServer, authKey: issued.authkey, hostname: "mesh-e2e-phone", stateDir: phone.stateDir });
  assert.equal((await readTailscaleStatus(phone.cliOptions)).backendState, "Running");
  const authPath = `${origin}/api/web-auth/status`;
  const unauth = await waitFor("peer TCP/HTTP connectivity", async () => {
    const res = await throughPeer(phone.proxyPort, authPath);
    return res.status === 200 ? res : null;
  }, 35_000);
  assert.equal(JSON.parse(unauth.body).authenticated, false);
  console.log("PASS independent userspace peer connects to the real AgentRoam HTTP gateway");

  assert.match((await cliCommand("status")).stdout, /状态：joined/);
  const { grant } = await local("/api/pairing/admin/qr", {});
  const invitation = new URL(pairingQrPayload(origin, grant));
  const exchange = async () => throughPeer(phone.proxyPort, `${invitation.origin}/api/pairing/qr-exchange`, {
    method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
    body: { grant: invitation.hash.slice(6), name: "Mesh E2E mobile" },
  });
  const paired = await exchange();
  assert.equal(paired.status, 200);
  const { token, device } = JSON.parse(paired.body);
  assert.match(token, /^[a-z0-9_-]{43}$/i);
  assert.equal((await exchange()).status, 410);
  const headers = { origin: "http://localhost", authorization: `Bearer ${token}` };
  const remote = await throughPeer(phone.proxyPort, `${origin}/api/mesh/status`, { headers });
  assert.equal(remote.status, 200);
  assert.equal(JSON.parse(remote.body).phase, "joined");
  const page = await throughPeer(phone.proxyPort, `${origin}/web`, { headers: { ...headers, accept: "text/html" } });
  assert.equal(page.status, 200);
  const boot = JSON.parse((await throughPeer(phone.proxyPort, `${origin}/api/web-console/bootstrap`, { headers })).body);
  await webSocketHello(phone.proxyPort, origin, boot.wsNonce, device.id);
  console.log("PASS mobile pairing, one-use grant, authorized web access and authenticated WebSocket hello");
  if (process.env.TS_DEBUG_ALWAYS_USE_DERP === "1") {
    const peerLog = await readFile(join(root, "phone.log"), "utf8");
    assert.match(peerLog, /derp-\d+ connected/);
    console.log("PASS mobile traffic with direct UDP disabled and DERP connected");
  }

  const replay = await startPeer("replayed-registration");
  await assert.rejects(
    tailscaleUp({ ...replay.cliOptions, timeoutMs: 8_000 }, { loginServer, authKey: issued.authkey, hostname: "replayed-key", stateDir: replay.stateDir }),
    /authkey already used/i,
  );

  const outsider = await startPeer("unrelated");
  const outsiderUser = await control.getOrCreateUser("unrelated");
  const outsiderKey = await control.createPreAuthKey(outsiderUser);
  await tailscaleUp(outsider.cliOptions, { loginServer, authKey: outsiderKey.key, hostname: "unrelated", stateDir: outsider.stateDir });
  assert.equal((await readTailscaleStatus(outsider.cliOptions)).backendState, "Running");
  const isolated = await throughPeer(outsider.proxyPort, authPath).catch(() => null);
  assert.ok(isolated === null || isolated.status === 502 || isolated.status === 503 || isolated.status === 504);
  console.log("PASS Headscale rejects key reuse and blocks a node from a different installation");

  await stopDesktop();
  const restarted = await runDesktop();
  assert.equal(restarted.tailnetIPv4, initial.tailnetIPv4);
  assert.equal(restarted.joinedAt, initial.joinedAt);
  assert.equal((await control.listNodes()).find(node => node.ipAddresses.includes(restarted.tailnetIPv4))?.id, originalNode.id);
  await waitFor("authorized peer access after desktop restart", async () => {
    const response = await throughPeer(phone.proxyPort, authPath, { headers });
    return response.status === 200 && JSON.parse(response.body).authenticated;
  });
  await cliCommand("offboard");
  assert.equal((await local("/api/mesh/status")).phase, "offboarded");
  assert.equal((await control.listNodes()).find(node => node.id === originalNode.id), undefined);
  await stopDesktop();
  assert.equal((await runDesktop()).phase, "offboarded");
  await cliCommand("onboard");
  assert.equal((await local("/api/mesh/status")).phase, "joined");
  console.log("PASS CLI offboard, Headscale node removal, restart persistence and explicit rejoin");
} catch (error) {
  failed = true;
  for (const name of ["headscale", "agentroam", "phone"]) {
    const log = await readFile(join(root, `${name}.log`), "utf8").catch(() => "");
    if (log) console.error(`${name}:\n${log.split("\n").slice(-12).join("\n")}`.replace(/tskey-[^\s"']+/g, "[redacted]"));
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  if (desktop) { desktop.detach(); await desktop.runtime.close(); }
  for (const processHandle of [...hosts].reverse()) await stop(processHandle);
  await rm(root, { recursive: true, force: true });
  if (!failed) console.log("PASS isolated mesh end-to-end");
}
