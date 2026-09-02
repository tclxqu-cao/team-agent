#!/usr/bin/env node
/**
 * Public relay pairing + WebSocket smoke test.
 * Usage: node scripts/verify-cli-tunnel.mjs [main.tgz] [platform.tgz] [--node /path/to/node22] [--provider auto|cloudflare|pinggy]
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const nodeBin = args.includes("--node") ? args[args.indexOf("--node") + 1] : process.execPath;
const tarballs = args.filter((arg) => arg.endsWith(".tgz")).map((path) => resolve(path));
const tarball = tarballs.find((path) => /agentroam-0\.2\.0-preview\.5\.tgz$/.test(path))
  ?? resolve(root, "packages/cli/agentroam-0.2.0-preview.5.tgz");
const platformTarball = tarballs.find((path) => /agentroam-cloudflared-darwin-arm64-0\.2\.0-preview\.5\.tgz$/.test(path))
  ?? resolve(root, "packages/cloudflared-darwin-arm64/agentroam-cloudflared-darwin-arm64-0.2.0-preview.5.tgz");
const provider = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : "auto";
if (!["auto", "cloudflare", "pinggy"].includes(provider)) throw new Error(`invalid provider: ${provider}`);
const commandEnv = { ...process.env, PATH: `${dirname(nodeBin)}${delimiter}${process.env.PATH ?? ""}` };

const workdir = mkdtempSync(resolve(tmpdir(), "agentroam-tunnel-"));
console.log(`workdir: ${workdir}`);
let child;

try {
  execFileSync("npm", ["init", "-y"], { cwd: workdir, stdio: "inherit", env: commandEnv });
  execFileSync("npm", ["install", "--offline", platformTarball, tarball], { cwd: workdir, stdio: "inherit", env: commandEnv });
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
  const openMatch = await waitFor(/Open: (https:\/\/[^\s]+\/web\?pair=[^\s]+)/, () => output, 10000);
  const accessUrl = new URL(openMatch[1]);
  const publicBase = accessUrl.origin;
  const pairingToken = accessUrl.searchParams.get("pair");
  if (!pairingToken) throw new Error("pairing token missing from public URL");

  const initialStatus = await waitForPublicStatus(`${publicBase}/api/web-auth/status`, 60000);
  console.log(`✓ public health: ${initialStatus.response.status}`);

  const setup = await fetchJson(`${publicBase}/api/web-auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-device-name": "cli-release-e2e" },
    body: JSON.stringify({
      username: "release-e2e",
      password: `Release-E2E-${randomBytes(12).toString("hex")}`,
      pairingToken,
    }),
  });
  if (setup.response.status !== 201) {
    throw new Error(`pairing setup failed: ${setup.response.status} ${JSON.stringify(setup.body)}`);
  }

  const setCookies = getSetCookies(setup.response.headers);
  const authCookie = setCookies.find((value) => value.startsWith("customer_agent_session="));
  const deviceCookie = setCookies.find((value) => value.startsWith("customer_agent_device="));
  if (!authCookie || !deviceCookie) throw new Error("pairing response did not set auth cookies");
  assertCookieFlags(authCookie, ["secure", "httponly", "samesite=strict"]);
  assertCookieFlags(deviceCookie, ["secure", "samesite=strict"]);
  const cookie = [authCookie, deviceCookie].map((value) => value.split(";", 1)[0]).join("; ");
  console.log("✓ pairing setup + Secure Cookie");

  const authenticated = await fetchJson(`${publicBase}/api/web-auth/status`, { headers: { cookie } });
  if (!authenticated.body.authenticated) throw new Error("paired session is not authenticated");
  const bootstrap = await fetchJson(`${publicBase}/api/web-console/bootstrap`, { headers: { cookie } });
  if (!bootstrap.response.ok || !bootstrap.body.wsNonce) throw new Error("WebSocket bootstrap failed");

  const runtimeRequire = createRequire(resolve(workdir, "node_modules/agentroam/runtime/package.json"));
  const { WebSocket } = runtimeRequire("ws");
  const wsUrl = `${publicBase.replace(/^https:/, "wss:")}/ws?nonce=${encodeURIComponent(bootstrap.body.wsNonce)}`;
  const hello = await waitForWebSocketHello(WebSocket, wsUrl, { Cookie: cookie, Origin: publicBase });
  if (hello.type !== "connection:hello" || hello.userId !== setup.body.user.id) {
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
      if (result.response.ok && result.body.needsSetup) return result;
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

function waitForWebSocketHello(WebSocket, url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
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
