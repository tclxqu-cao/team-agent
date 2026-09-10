#!/usr/bin/env node
// 端到端测试：手机远程连接桌面（desktop live view 链路）。
//
// 真实组件：ws-server（Next /ws 中继 + bootstrap 鉴权）、@agent/core 的
// LiveViewProducerClient / LiveViewProducer（与桌面 App 主进程完全相同的发布代码）。
// 替身：ScreencastPort（内存 JPEG 帧源）与 InputPort（记录注入命令）——这两层是
// Electron desktopCapturer / Swift helper，无法在无 GUI 测试中运行，由单测覆盖。
//
// 必须用 node 运行（bun 的 ws 客户端 shim 会把 101 握手误报为普通响应）。
//
// 断言链路（对应设计文档真机验收）：
//   桌面发布 → 手机列表可见 → 观看收到 JPEG 帧 → 接管(状态机 user-controlled)
//   → 远程鼠标/键盘注入到桌面输入口 → 归还(agent-controlled)。
//
// 运行：node scripts/e2e-desktop-live.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "packages", "server", "package.json"));
const { LiveViewProducer, LiveViewProducerClient, readLiveFramePacket, LIVE_FRAME_PACKET_TYPE } = require("@agent/core");
const WebSocket = require("ws");

const PORT = Number(process.env.E2E_PORT || 3579);
const EXTERNAL_ENDPOINT = process.env.E2E_ENDPOINT?.trim() || "";
const ENDPOINT = EXTERNAL_ENDPOINT || `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(fn, { timeoutMs, label, intervalMs = 250 }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try { return await fn(); } catch (error) { lastError = error; }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}: ${lastError?.message || lastError}`);
}

async function fetchJson(path) {
  const response = await fetch(`${ENDPOINT}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
  return response.json();
}

// ── 替身：桌面画面源（内存 JPEG 循环）+ 输入口（记录注入命令）──
// 注意 start() 必须像真实 DesktopScreenScreencast 一样阻塞到 stop()，
// 否则 LiveViewProducer 会立刻走完生命周期并关闭会话。
class FakeScreencast {
  constructor() {
    this.running = false;
    this.dispatched = [];
    this.framesSent = 0;
  }
  async start(onFrame) {
    this.running = true;
    while (this.running) {
      await sleep(80);
      if (!this.running) return;
      this.framesSent += 1;
      await onFrame({
        data: MINIMAL_JPEG,
        viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
        title: "E2E 桌面",
        url: "",
        timestamp: Date.now(),
      });
    }
  }
  async stop() {
    this.running = false;
  }
  async dispatchInput(input) {
    this.dispatched.push(input);
  }
}

// ≥16 字节的最小合法 JPEG（registry 下限校验），无需真实可解码
const MINIMAL_JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // SOI + APP0
  Buffer.alloc(24, 0x42),
  Buffer.from([0xff, 0xd9]), // EOI
]);

// ── 手机侧 ws 客户端（与 Web 控制台 useGateway 相同的接入方式）──
class PhoneWatcher {
  constructor(nonce) {
    const wsUrl = `${ENDPOINT.replace(/^http/, "ws")}/ws?nonce=${encodeURIComponent(nonce)}`;
    this.ws = new WebSocket(wsUrl, {
      headers: { Origin: ENDPOINT },
    });
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.binaryFrames = [];
    this.waiters = [];
    this.ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        const packet = readLiveFramePacket(Buffer.from(raw));
        if (packet && packet.type === LIVE_FRAME_PACKET_TYPE.watcherFrame) {
          this.binaryFrames.push(packet);
          this.#notify();
        }
        return;
      }
      const message = JSON.parse(raw.toString("utf8"));
      if (process.env.E2E_DEBUG && message.type !== "browser:frame") console.log("  [watcher] ←", JSON.stringify(message).slice(0, 220));
      if (message.id != null && (message.type === "error" || String(message.type).endsWith(":result"))) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        pending(message);
        return;
      }
      this.events.push(message);
      this.#notify();
    });
    this.open = new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("close", (code, reason) => {
      if (process.env.E2E_DEBUG) console.log("  [watcher] closed:", code, String(reason));
    });
    this.ws.on("error", (error) => {
      if (process.env.E2E_DEBUG) console.log("  [watcher] error:", error.message);
    });
  }
  #notify() {
    for (const waiter of this.waiters) waiter();
    this.waiters = [];
  }
  #onChange() { return new Promise((resolve) => this.waiters.push(resolve)); }
  close() { this.ws.close(); }
  rpc(type, payload = {}, timeoutMs = 10_000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} timeout`));
      }, timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.type === "error") reject(Object.assign(new Error(message.error), { code: message.code }));
        else resolve(message);
      });
      this.ws.send(JSON.stringify({ type, _req: id, ...payload }));
    });
  }
  async waitForEvent(types, predicate = () => true, timeoutMs = 10_000) {
    const typeSet = new Set(Array.isArray(types) ? types : [types]);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find((event) => typeSet.has(event.type) && predicate(event));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timeout waiting for event [${[...typeSet].join(", ")}]`);
      await Promise.race([this.#onChange(), sleep(100)]);
    }
  }
  async waitForFrame(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.binaryFrames.length > 0) return this.binaryFrames[this.binaryFrames.length - 1];
      if (Date.now() > deadline) throw new Error("timeout waiting for binary frame");
      await Promise.race([this.#onChange(), sleep(50)]);
    }
  }
}

// ── 服务器 ──
function startServer(dataDir) {
  // E2E_ENDPOINT 已设置时复用外部运行的服务器（跳过 spawn/清理）
  if (process.env.E2E_ENDPOINT) return null;
  // detached + 进程组 kill：Next dev 会 fork 子进程，只杀父进程会残留占端口
  const child = spawn("node", ["ws-server.mjs"], {
    cwd: join(repoRoot, "packages", "server"),
    detached: true,
    env: {
      ...process.env,
      PORT: String(PORT),
      AGENT_DATA_DIR: dataDir,
      NEXT_DIST_DIR: ".next-e2e",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  return { child, getOutput: () => output };
}

function stopServer(server) {
  try { process.kill(-server.child.pid, "SIGTERM"); } catch {}
  return sleep(800).then(() => {
    try { process.kill(-server.child.pid, "SIGKILL"); } catch {}
  });
}

// ── 主流程 ──
const dataDir = EXTERNAL_ENDPOINT ? null : mkdtempSync(join(tmpdir(), "agent-live-e2e-"));
const server = startServer(dataDir);
let producerRun = null;
let watcher = null;
let secondDevice = null;
let exitCode = 0;

try {
  // 1. 服务器就绪（bootstrap 即桌面 App 与手机共同的首跳）
  await waitFor(() => fetchJson("/api/web-console/bootstrap"), { timeoutMs: 120_000, label: "server bootstrap" });
  check("server /api/web-console/bootstrap 就绪", true);

  // 2. 桌面端：与 desktop-screen-live.ts 相同的接线（LiveViewProducerClient + LiveViewProducer）
  const screencast = new FakeScreencast();
  const producerClient = new LiveViewProducerClient({ endpoint: ENDPOINT });
  const producer = new LiveViewProducer({
    client: producerClient,
    screencast,
    metadata: { sessionId: "desktop:primary", backend: "desktop", title: "桌面屏幕", url: "" },
    pauseAgent: async () => undefined,
    resyncAgent: async () => undefined,
    onError: (error) => console.log("  [producer error]", error?.message || error),
  });
  producerRun = producer.run().catch((error) => console.log("  [producer exited]", error?.message || error));

  // 3. 手机侧：bootstrap nonce → ws 接入
  const bootstrap = await fetchJson("/api/web-console/bootstrap");
  watcher = new PhoneWatcher(bootstrap.wsNonce);
  await watcher.open;

  // 4. 会话发现
  const listView = await waitFor(async () => {
    const reply = await watcher.rpc("browser:list");
    const session = (reply.sessions || []).find((item) => item.id === "desktop:primary");
    if (!session) throw new Error("desktop:primary not listed");
    return session;
  }, { timeoutMs: 15_000, label: "browser:list desktop:primary" });
  check("手机 browser:list 看到桌面会话", listView.backend === "desktop", `backend=${listView.backend}`);

  // 5. 观看：watch 后等待 ready（publish 元数据走 browser:session，所有权走 browser:state）
  const watchReply = await watcher.rpc("browser:watch", { sessionId: "desktop:primary" });
  check("手机 browser:watch 成功", watchReply.session?.id === "desktop:primary", `viewerCount=${watchReply.session?.viewerCount}`);
  const readyEvent = await watcher.waitForEvent(
    ["browser:state", "browser:session"],
    (event) => event.session?.availability === "ready",
  );
  check("首帧后 availability=ready", readyEvent.session.state === "agent-controlled", `state=${readyEvent.session.state} via ${readyEvent.type}`);
  const frame = await watcher.waitForFrame();
  check("手机收到 JPEG 直播帧", frame.payload.length > 16 && frame.payload[0] === 0xff && frame.payload[1] === 0xd8, `${frame.payload.length}B seq=${frame.sequence}`);

  // 6. 接管：registry → producer takeover 事件 → producer 置 user-controlled
  const takeover = await watcher.rpc("browser:takeover", { sessionId: "desktop:primary" });
  check("接管请求被接受", takeover.session?.state === "handoff-requested", `state=${takeover.session?.state}`);
  const controlled = await watcher.waitForEvent("browser:state", (event) => event.session?.state === "user-controlled");
  check("桌面端交接完成 user-controlled", Boolean(controlled.session), `viewerCount=${controlled.session?.viewerCount}`);

  // 7. 远程输入：鼠标 + 键盘注入到桌面输入口
  await watcher.rpc("browser:input", {
    sessionId: "desktop:primary",
    input: { kind: "pointer", action: "down", x: 0.5, y: 0.5, button: "left" },
  });
  await watcher.rpc("browser:input", {
    sessionId: "desktop:primary",
    input: { kind: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: [] },
  });
  await waitFor(() => {
    if (screencast.dispatched.length < 2) throw new Error(`dispatched=${screencast.dispatched.length}`);
    return screencast.dispatched;
  }, { timeoutMs: 5_000, label: "desktop input dispatch" });
  const [pointer, key] = screencast.dispatched;
  check("远程鼠标点击到达桌面输入口", pointer?.kind === "pointer" && pointer?.action === "down" && pointer?.x === 0.5, JSON.stringify(pointer));
  check("远程键盘输入到达桌面输入口", key?.kind === "key" && key?.code === "KeyA", JSON.stringify(key));

  // 8. 未接管者写入被拒（写锁）
  const bootstrap2 = await fetchJson("/api/web-console/bootstrap");
  secondDevice = new PhoneWatcher(bootstrap2.wsNonce);
  await secondDevice.open;
  let writeLocked = false;
  try {
    await secondDevice.rpc("browser:input", { sessionId: "desktop:primary", input: { kind: "key", action: "down", key: "x", code: "KeyX", text: "x", modifiers: [] } });
  } catch (error) {
    writeLocked = error.code === "EWRITELOCK";
  }
  check("第二台设备只读（EWRITELOCK）", writeLocked);
  secondDevice.close();

  // 9. 归还控制权
  await watcher.rpc("browser:return", { sessionId: "desktop:primary" });
  await watcher.waitForEvent("browser:state", (event) => event.session?.state === "agent-controlled");
  check("归还后回到 agent-controlled", true);
} catch (error) {
  check(`E2E 流程失败: ${error.message}`, false);
  console.error(error);
} finally {
  watcher?.close();
  secondDevice?.close();
  producerRun = null;
  if (server) {
    rmSync(dataDir, { recursive: true, force: true });
    await stopServer(server);
  }
}

const failed = results.filter((item) => !item.ok);
console.log(`\n=== 桌面直播端到端测试：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  exitCode = 1;
  if (server) {
    const lines = server.getOutput().split("\n");
    const tailIndex = Math.max(0, lines.length - 200);
    console.log("服务器日志（尾部）：");
    console.log(lines.slice(tailIndex).join("\n"));
  }
}
process.exit(exitCode);
