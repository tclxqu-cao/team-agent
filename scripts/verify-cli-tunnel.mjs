#!/usr/bin/env node
/**
 * Public relay pairing + WebSocket smoke test.
 * Usage: node scripts/verify-cli-tunnel.mjs [--artifacts dist/cli-release] [--node /path/to/node22] [--provider auto|cloudflare|pinggy]
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { delimiter, dirname, resolve } from "node:path";
import { releasePackageNames, resolveReleaseArtifacts } from "./cli-release-artifacts.mjs";

const args = process.argv.slice(2);
const nodeBin = args.includes("--node") ? args[args.indexOf("--node") + 1] : process.execPath;
const artifacts = resolveReleaseArtifacts(args);
const packageSet = releasePackageNames(artifacts.target);
const provider = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : "auto";
if (!["auto", "cloudflare", "pinggy"].includes(provider)) throw new Error(`invalid provider: ${provider}`);
const commandEnv = { ...process.env, PATH: `${dirname(nodeBin)}${delimiter}${process.env.PATH ?? ""}` };
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

const workdir = mkdtempSync(resolve(tmpdir(), "agentroam-tunnel-"));
console.log(`workdir: ${workdir}`);
let child;

try {
  execFileSync(npmBin, ["init", "-y"], { cwd: workdir, stdio: "inherit", env: commandEnv });
  execFileSync(npmBin, [
    "install",
    "--prefer-offline",
    "--no-audit",
    "--no-fund",
    artifacts.runtime,
    artifacts.cloudflared,
    artifacts.launcher,
  ], {
    cwd: workdir,
    stdio: "inherit",
    env: commandEnv,
  });
  const pkgBin = resolve(workdir, "node_modules/agentroam/bin/agentroam.mjs");
  const dataDir = resolve(workdir, "data");

  child = spawn(
    nodeBin,
    [pkgBin, "start", "--relay", provider, "--no-qr", "--data-dir", dataDir, "--root", workdir],
    { cwd: workdir, stdio: ["ignore", "pipe", "pipe"], env: commandEnv },
  );

  let output = "";
  const append = (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text.replace(/pair=[^\s&]+/g, "pair=[REDACTED]"));
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const ready = await waitFor(/✓ (Cloudflare|Pinggy) tunnel ready: (https:\/\/[^\s]+)/, () => output, 120000);
  console.log(`✓ selected relay: ${ready[1]}`);
  const openMatch = await waitFor(/Open: (https:\/\/[^\s]+\/web)/, () => output, 10000);
  const accessUrl = new URL(openMatch[1]);
  const publicBase = accessUrl.origin;

  const initialStatus = await waitForPublicStatus(`${publicBase}/api/web-auth/status`, 60000);
  console.log(`✓ public health: ${initialStatus.response.status}`);

  const unauthorized = await fetch(`${publicBase}/app/`);
  if (unauthorized.status !== 401) throw new Error("unpaired public app access must be rejected");
  const { pairingAdmin } = await import(pathToFileURL(resolve(workdir, "node_modules/agentroam/dist/device-pairing.js")).href);
  const { grant } = await pairingAdmin(dataDir, "qr");
  const paired = await fetchJson(`${publicBase}/api/pairing/qr-exchange`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: publicBase },
    body: JSON.stringify({ grant, name: "cli-release-e2e" }),
  });
  if (paired.response.status !== 200 || !paired.body.device?.id) {
    throw new Error(`QR pairing failed: ${paired.response.status} ${JSON.stringify(paired.body)}`);
  }

  const deviceCookie = getSetCookies(paired.response.headers).find((value) => value.startsWith("agentroam_device_session="));
  if (!deviceCookie) throw new Error("QR pairing did not issue a device session");
  assertCookieFlags(deviceCookie, ["secure", "httponly", "samesite=strict"]);
  const cookie = deviceCookie.split(";", 1)[0];
  console.log("✓ QR pairing + Secure Cookie");

  const authenticated = await fetchJson(`${publicBase}/api/web-auth/status`, { headers: { cookie } });
  if (!authenticated.body.authenticated) throw new Error("paired session is not authenticated");
  const bootstrap = await fetchJson(`${publicBase}/api/web-console/bootstrap`, { headers: { cookie } });
  if (!bootstrap.response.ok || !bootstrap.body.wsNonce) throw new Error("WebSocket bootstrap failed");
  if (bootstrap.body.deviceId !== paired.body.device.id) throw new Error("bootstrap device mismatch");
  const webapp = await fetch(`${publicBase}/app/`, { headers: { cookie } });
  if (!webapp.ok || !(await webapp.text()).includes("<script")) throw new Error("paired public webapp failed");
  console.log("✓ paired public webapp");

  const runtimeRequire = createRequire(resolve(workdir, "node_modules", packageSet.runtime, "runtime/package.json"));
  const { WebSocket } = runtimeRequire("ws");
  const wsUrl = `${publicBase.replace(/^https:/, "wss:")}/ws?nonce=${encodeURIComponent(bootstrap.body.wsNonce)}`;
  const wsAgent = createWebSocketProxyAgent(runtimeRequire);
  let hello;
  try {
    hello = await waitForWebSocketHello(WebSocket, wsUrl, {
      headers: { Cookie: cookie, Origin: publicBase },
      agent: wsAgent,
    });
  } finally {
    wsAgent?.destroy?.();
  }
  if (hello.type !== "connection:hello" || hello.userId !== bootstrap.body.user?.id || hello.deviceId !== paired.body.device.id) {
    throw new Error(`unexpected WebSocket hello: ${JSON.stringify(hello)}`);
  }
  console.log("✓ authenticated WSS connection");

  child.kill("SIGTERM");
  await waitExit(child, 15000);
  child = undefined;
  console.log(`✓ ${ready[1]} public tunnel smoke test passed`);
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGTERM");
    await waitExit(child, 15000).catch(() => {});
  }
  rmSync(workdir, { recursive: true, force: true });
}

async function fetchJson(url, init) {
  const response = await fetch(url, { redirect: "follow", ...init });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitForPublicStatus(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < end) {
    try {
      const result = await fetchJson(url);
      if (result.response.ok && result.body.pairingRequired && !result.body.authenticated) return result;
      lastError = new Error(`HTTP ${result.response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`public health timeout: ${lastError?.message || "unknown error"}`);
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  return (headers.get("set-cookie") || "").split(/,(?=\s*[^;,]+=)/).map((value) => value.trim());
}

function assertCookieFlags(cookie, flags) {
  const normalized = cookie.toLowerCase();
  for (const flag of flags) {
    if (!normalized.includes(flag)) throw new Error(`cookie missing ${flag}: ${cookie}`);
  }
}

function createWebSocketProxyAgent(runtimeRequire) {
  const value = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!value) return undefined;
  const proxy = new URL(value);
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") return undefined;
  const tunnel = runtimeRequire("tunnel-agent");
  const proxyOptions = {
    host: proxy.hostname,
    port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)),
    ...(proxy.username || proxy.password
      ? { proxyAuth: `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}` }
      : {}),
  };
  return proxy.protocol === "https:"
    ? tunnel.httpsOverHttps({ proxy: proxyOptions })
    : tunnel.httpsOverHttp({ proxy: proxyOptions });
}

function waitForWebSocketHello(WebSocket, url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WebSocket hello timeout"));
    }, 20000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      try {
        const message = JSON.parse(data.toString());
        ws.close();
        resolve(message);
      } catch (error) {
        ws.terminate();
        reject(error);
      }
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitFor(pattern, getText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + timeoutMs;
    const tick = () => {
      const match = getText().match(pattern);
      if (match) return resolve(match);
      if (Date.now() > end) return reject(new Error(`timeout waiting for ${pattern}\n${getText().slice(-2000)}`));
      setTimeout(tick, 500);
    };
    tick();
  });
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("process did not exit"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}
