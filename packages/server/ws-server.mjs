#!/usr/bin/env node
import { RemoteAuthorization } from "./lib/remote-control/remote-authorization.mjs";
import { createDevicePairingGateway } from "./lib/device-pairing-gateway.mjs";
import { createDesktopDiscovery } from "./lib/desktop-discovery.mjs";
// ws-server.mjs — custom server for @agent/server.
// Serves the Next.js app (API + /web console) and multiplexes a WebSocket
// channel on the SAME port for the remote terminal (PTY) and file services.
//
// Frame protocol:
//   binary frames        → raw PTY bytes for the focused terminal
//   text frames (JSON)   → control protocol ({type, ...} / {type:"...:result", id})
//
// Auth: HttpOnly account session cookie + one-time WebSocket nonce.
//
// Env:
//   PORT              HTTP/WS port           (default 3000)
//   AGENT_DATA_DIR    stable base directory for .agent-data/agent.db
//   AGENT_WEB_ALLOWED_ORIGINS comma-separated extra browser origins
//   AGENT_WEB_ROOTS   ":"-separated dirs the file APIs may touch (default: $HOME)

import { ViewerFrameFlow } from "./lib/browser-live/viewer-frame-flow.mjs";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import chokidar from "chokidar";
import { LiveViewRegistry, HostPathPolicy, SQLiteAnonymousWebStore, SQLiteProjectStore, SQLiteWebConsoleStore, encodeLiveFramePacket, readLiveFramePacket, LIVE_FRAME_PACKET_TYPE, MAX_RELAY_SITES, MAX_RELAY_TEXT_LENGTH, MAX_RELAY_IMAGES, MAX_RELAY_IMAGE_LENGTH } from "@agent/core";
import { decodeOsc7Path, selectDefaultShell } from "./shell-platform.mjs";
import { consumeTerminalReadyMarker, createTerminalShellLaunch } from "./shell-integration.mjs";
import {
  createPreviewTicketRegistry,
  inspectTextFile,
  inspectTextFileStatus,
  saveTextFile,
  serveMarkdownPreview,
  servePreviewFile,
} from "./lib/file-preview-service.mjs";
import { isMarkdownPreviewPath } from "./lib/markdown-preview.mjs";
import { aiHubRelayBroadcast, aiHubRelayCapture, aiHubRelayStatus } from "./lib/ai-hub-relay-client.mjs";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const dir = path.dirname(fileURLToPath(import.meta.url));

// Next.js 会自动加载 .env.local，但本进程在 Next 启动前就要读 AGENT_* 变量
// （如 AGENT_WEB_ROOTS、AGENT_DATA_DIR），因此这里自行加载同目录的 .env.local。
// 已存在的进程环境变量优先，不被覆盖。
try {
  for (const rawLine of fsSync.readFileSync(path.join(dir, ".env.local"), "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in process.env) continue;
    process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
} catch {}

const serverBaseDir = path.resolve(process.env.AGENT_DATA_DIR?.trim() || dir);
const anonymousWebStore = new SQLiteAnonymousWebStore(serverBaseDir);
const consoleStore = new SQLiteWebConsoleStore(serverBaseDir);
const projectStore = new SQLiteProjectStore(serverBaseDir);
consoleStore.markStaleTerminalsExited(new Date().toISOString());
const hostPathPolicy = HostPathPolicy.fromEnvironment(process.env.AGENT_WEB_ROOTS, os.homedir());
const roots = hostPathPolicy.roots;
const previewTickets = createPreviewTicketRegistry();
const liveViewRegistry = new LiveViewRegistry();

// bun install drops the executable bit on node-pty's prebuilt spawn-helper,
// which makes every pty.spawn fail with "posix_spawnp failed". Repair on boot
// (same fix as packages/cli repairNativeRuntimePermissions, for the dev path).
try {
  if (process.platform !== "win32") {
    const { createRequire } = await import("node:module");
    const nodePtyRoot = path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
    const helper = path.join(nodePtyRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (fsSync.existsSync(helper) && !(fsSync.statSync(helper).mode & 0o111)) fsSync.chmodSync(helper, 0o755);
  }
} catch { /* best effort — pty.spawn reports its own error */ }

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// ── scrollback ring buffer (bytes) ──────────────────────────────────────────
class Scrollback {
  constructor(maxBytes = 512 * 1024) {
    this.maxBytes = maxBytes;
    /** @type {Buffer[]} */
    this.chunks = [];
    this.total = 0;
  }
  /** @returns {Buffer} the appended copy (for fanning out) */
  append(data) {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    this.chunks.push(buf);
    this.total += buf.byteLength;
    while (this.total > this.maxBytes && this.chunks.length > 1) {
      this.total -= this.chunks.shift().byteLength;
    }
    if (this.chunks.length === 1 && this.chunks[0].byteLength > this.maxBytes) {
      this.chunks[0] = this.chunks[0].subarray(this.chunks[0].byteLength - this.maxBytes);
      this.total = this.maxBytes;
    }
    return buf;
  }
  snapshot() {
    return Buffer.concat(this.chunks, this.total);
  }
}

// ── persistent terminal sessions (survive client reconnects) ────────────────
/** @type {Map<string, TerminalSession>} */
const terminals = new Map();
const TERMINAL_IDLE_MS = 2 * 60 * 60 * 1000;

// ── terminal cwd tracking (foreground process group, not parent shell) ──────
const CWD_POLL_MS = 1500;

async function lsofCwd(pid) {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeout: 3000 });
    // lines: "p<pid>", "c<cmd>", "n<cwd>"; take the n line
    const m = stdout.split("\n").find((l) => l.startsWith("n"));
    return m ? m.slice(1) : null;
  } catch {
    return null;
  }
}

async function readProcessCwd(shellPid) {
  if (process.platform === "win32") return null;
  let foregroundPgid = shellPid;
  try {
    // tpgid is the foreground process-group leader for the PTY. While an
    // Agent TUI is running it points at opencode/codex/claude, not zsh.
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "tpgid=", "-p", String(shellPid)], { timeout: 3000 });
    const parsed = Number.parseInt(stdout.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) foregroundPgid = parsed;
  } catch {}

  // `bun run tui` / `npm exec` keep a wrapper as the process-group leader;
  // the actual Agent is a deeper child in the SAME foreground group and may
  // chdir independently. Prefer deepest group members, then the leader/shell.
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], { timeout: 3000 });
    const members = stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, ppid, pgid]) => Number.isInteger(pid) && Number.isInteger(ppid) && pgid === foregroundPgid)
      .map(([pid, ppid]) => ({ pid, ppid }));
    const byPid = new Map(members.map((p) => [p.pid, p]));
    const depthOf = (p) => {
      let depth = 0;
      let cursor = p;
      const seen = new Set();
      while (cursor && byPid.has(cursor.ppid) && !seen.has(cursor.ppid)) {
        seen.add(cursor.ppid);
        cursor = byPid.get(cursor.ppid);
        depth++;
      }
      return depth;
    };
    members.sort((a, b) => depthOf(b) - depthOf(a) || b.pid - a.pid);
    for (const member of members.slice(0, 6)) {
      const cwd = await lsofCwd(member.pid);
      if (cwd) return cwd;
    }
  } catch {}

  const leaderCwd = await lsofCwd(foregroundPgid);
  if (leaderCwd) return leaderCwd;
  return foregroundPgid === shellPid ? null : lsofCwd(shellPid);
}

function watchTerminalCwd(session, onCwd) {
  let last = null;
  const timer = setInterval(async () => {
    if (session.exited || !terminals.has(session.id)) {
      clearInterval(timer);
      return;
    }
    if (session.cwdWatchers.size === 0) return;
    const cwd = await readProcessCwd(session.pid);
    if (cwd && cwd !== last) {
      last = cwd;
      onCwd(cwd);
    }
  }, CWD_POLL_MS);
  timer.unref?.();
}

const { execFile } = await import("node:child_process");
const execFileAsync = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, opts ?? {}, (err, stdout, stderr) => {
      if (err && !stdout) return reject(err);
      resolve({ stdout, stderr, exitCode: err?.code ?? 0 });
    });
  });

/**
 * @typedef {{id:string, userId:string, pid:number, cwd:string|null, pty:import('node-pty').IPty, scrollback:Scrollback,
 *            size:{cols:number,rows:number}, watchers:Set<(b:Uint8Array)=>void>,
 *            shell:string, exited:boolean, closed:boolean, cwdWatchers:Set<(cwd:string)=>void>, inputOwner:string|null, oscTail:string,
 *            ready:boolean, readyTail:string, readyWatchers:Set<()=>void>, initialCommand:string, initialCommandSent:boolean}} TerminalSession
 */

function markTerminalReady(session) {
  if (session.ready) return;
  session.ready = true;
  if (session.initialCommand && !session.initialCommandSent) {
    session.initialCommandSent = true;
    session.pty.write(`${session.initialCommand}\r`);
  }
  for (const notify of [...session.readyWatchers]) {
    try { notify(); } catch {}
  }
  session.readyWatchers.clear();
}

/** @returns {TerminalSession} */
function startTerminal(id, { userId, cols = 80, rows = 24, cwd, command, initialCommand } = {}) {
  const existing = terminals.get(id);
  if (existing && !existing.exited) return existing;
  const queuedCommand = typeof initialCommand === "string"
    && initialCommand.length <= 1000
    && !/[\r\n\0]/.test(initialCommand)
    ? initialCommand
    : "";

  const shell = selectDefaultShell();
  const launch = createTerminalShellLaunch({ shell, command, serverBaseDir, homeDir: os.homedir(), env: process.env });
  const initialCwd = cwd && fsSync.existsSync(cwd) ? path.resolve(cwd) : os.homedir();
  const p = pty.spawn(shell, launch.args, {
    name: "xterm-256color",
    cols: clampInt(cols, 2, 500, 80),
    rows: clampInt(rows, 2, 300, 24),
    cwd: initialCwd,
    env: launch.env,
  });

  /** @type {TerminalSession} */
  const session = {
    id,
    userId,
    pid: p.pid,
    cwd: initialCwd,
    shell,
    pty: p,
    scrollback: new Scrollback(),
    size: { cols, rows },
    watchers: new Set(),
    cwdWatchers: new Set(),
    inputOwner: null,
    closed: false,
    oscTail: "",
    ready: false,
    readyTail: "",
    readyWatchers: new Set(),
    initialCommand: queuedCommand,
    initialCommandSent: false,
    exited: false,
  };
  watchTerminalCwd(session, (cwd2) => {
    session.cwd = cwd2;
    consoleStore.updateTab(session.id, session.userId, { currentCwd: cwd2, lastActiveAt: new Date().toISOString() });
    for (const cb of [...session.cwdWatchers]) {
      try { cb(cwd2); } catch {}
    }
  });

  p.onData((data) => {
    if (!session.ready) {
      const readiness = consumeTerminalReadyMarker(session.readyTail, data);
      session.readyTail = readiness.tail;
      if (readiness.ready) markTerminalReady(session);
    }
    captureShellHistory(session, data);
    const copy = session.scrollback.append(data);
    for (const send of [...session.watchers]) {
      try { send(new Uint8Array(copy)); } catch {}
    }
  });
  p.onExit(({ exitCode }) => {
    session.exited = true;
    if (!session.closed) consoleStore.updateTab(session.id, session.userId, { status: "exited", exitedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() });
    // Tell attached clients the process is gone — otherwise the tab lives on
    // as an unresponsive zombie (no input, no output) until a page refresh.
    for (const conn of connections) {
      if (conn.attachedTo.has(id)) conn.sendJson({ type: "term:exited", id, code: exitCode });
    }
    for (const cb of [...session.cwdWatchers]) {
      try { cb(null); } catch {}
    }
    session.cwdWatchers.clear();
    session.readyWatchers.clear();
    const note = Buffer.from(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`, "utf8");
    session.scrollback.append(note);
    for (const send of [...session.watchers]) {
      try { send(new Uint8Array(note)); } catch {}
    }
    session.watchers.clear();
    terminals.delete(id);
  });
  // reap forgotten sessions even without an exit event
  setTimeout(() => {
    if (terminals.get(id) === session && !session.exited) {
      try { p.kill(); } catch {}
    }
  }, TERMINAL_IDLE_MS).unref?.();

  terminals.set(id, session);
  if (!launch.waitsForReady) markTerminalReady(session);
  return session;
}

function captureShellHistory(session, data) {
  const combined = session.oscTail + data;
  // 633;C;<b64 command>;<b64 cwd>[;<exit code>] — the exit code field is sent
  // by the zsh precmd hook; absent for reports from older hooks.
  const regex = /\x1b]633;C;([^;\x07]+);([^;\x07]+)(?:;(\d+))?\x07/g;
  let match;
  let lastEnd = 0;
  while ((match = regex.exec(combined))) {
    lastEnd = regex.lastIndex;
    try {
      const command = Buffer.from(match[1], "base64").toString("utf8");
      const cwd = Buffer.from(match[2], "base64").toString("utf8");
      const exitCode = match[3] !== undefined ? Number(match[3]) : null;
      if (command.trim()) consoleStore.addHistory(session.userId, session.id, command, cwd, new Date().toISOString(), exitCode);
    } catch {}
  }
  const cwdRegex = /\x1b]7;(file:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g;
  while ((match = cwdRegex.exec(combined))) {
    lastEnd = Math.max(lastEnd, cwdRegex.lastIndex);
    const cwd = decodeOsc7Path(match[1]);
    if (!cwd || cwd === session.cwd) continue;
    session.cwd = cwd;
    consoleStore.updateTab(session.id, session.userId, { currentCwd: cwd, lastActiveAt: new Date().toISOString() });
    for (const callback of [...session.cwdWatchers]) {
      try { callback(cwd); } catch {}
    }
  }
  const lastEscape = combined.lastIndexOf("\x1b]");
  session.oscTail = lastEscape >= lastEnd ? combined.slice(lastEscape).slice(-4096) : "";
}

// ── filesystem service ───────────────────────────────────────────────────────
function assertAllowed(absPath, userId) {
  // Static configured roots + current directories of active PTY sessions.
  // The user can already access these paths through the terminal; this keeps
  // the file manager aligned with terminal navigation without opening `/`
  // globally when the terminal still lives under $HOME.
  const activeCwds = [...terminals.values()].filter((s) => s.userId === userId).map((s) => s.cwd).filter(Boolean);
  return new HostPathPolicy([...roots, ...activeCwds]).assertAllowed(absPath);
}

async function fsList(dirPath, userId) {
  const abs = assertAllowed(dirPath, userId);
  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const dent of dirents) {
    if (dent.name === ".DS_Store") continue;
    let size = 0, mtime = 0;
    try {
      const st = await fsp.stat(path.join(abs, dent.name));
      size = st.size;
      mtime = st.mtimeMs;
    } catch { /* broken symlink etc. */ }
    entries.push({ name: dent.name, dir: dent.isDirectory(), symlink: dent.isSymbolicLink(), size, mtime });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return entries;
}

const MAX_READ_CHUNK = 256 * 1024;

const MIME_BY_EXT = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", xml: "application/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8",
  mdown: "text/markdown; charset=utf-8", mkdn: "text/markdown; charset=utf-8",
  mdx: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", m4v: "video/x-m4v",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg",
  pdf: "application/pdf",
};

const PLAIN_TEXT_EXTS = new Set([
  "ts", "tsx", "jsx", "cjs", "scss", "yml", "yaml", "toml", "sh", "zsh", "bash",
  "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "sql", "env",
  "gitignore", "log", "conf", "properties", "gradle", "lock", "vue", "svelte", "astro",
  "graphql", "prisma", "proto",
]);

function mimeFor(p) {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? (PLAIN_TEXT_EXTS.has(ext) ? "text/plain; charset=utf-8" : "application/octet-stream");
}

async function fsRead(filePath, offset = 0, length = MAX_READ_CHUNK, userId) {
  const abs = assertAllowed(filePath, userId);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "EISDIR" });
  const off = clampInt(offset, 0, st.size, 0);
  const len = clampInt(length, 1, MAX_READ_CHUNK, MAX_READ_CHUNK);
  const buf = Buffer.alloc(Math.min(len, st.size - off));
  if (buf.byteLength > 0) {
    const fh = await fsp.open(abs, "r");
    try {
      await fh.read(buf, 0, buf.byteLength, off);
    } finally {
      await fh.close();
    }
  }
  return { data: buf.toString("base64"), offset: off, bytes: buf.byteLength, eof: off + buf.byteLength >= st.size, size: st.size };
}

// ── per-connection file watchers ────────────────────────────────────────────
// SHALLOW watching only (depth: 1 = direct children). Deep recursive watches
// from $HOME explode the fd table (EMFILE crashes the process); the tree UI
// subscribes each expanded directory individually, so per-directory shallow
// watchers cover the whole visible depth at bounded cost.
// Current-level watching only. Do not ignore dotfiles: .env/.gitignore/etc.
// are real editable files and must refresh in the tree. Socket/pid files are
// not useful previews and can fail native watch setup.
const WATCH_IGNORED = [/\.(sock|pid)$/i];
const MAX_WATCHERS_PER_CONN = 40;
/** @type {Map<string, {watcher: any, lastUse: number}>} path → shared watcher */
const globalWatchers = new Map();
const MAX_TOTAL_WATCHERS = 120;

function getSharedWatcher(abs) {
  const existing = globalWatchers.get(abs);
  if (existing) {
    existing.lastUse = Date.now();
    return existing.watcher;
  }
  // LRU: retire the least recently used when full
  if (globalWatchers.size >= MAX_TOTAL_WATCHERS) {
    let oldestPath = null, oldestUse = Infinity;
    for (const [p, meta] of globalWatchers) {
      if (meta.lastUse < oldestUse) { oldestUse = meta.lastUse; oldestPath = p; }
    }
    if (oldestPath) {
      const meta = globalWatchers.get(oldestPath);
      meta.watcher.close().catch(() => {});
      globalWatchers.delete(oldestPath);
    }
  }
  const watcher = chokidar.watch(abs, {
    ignoreInitial: true,
    ignored: WATCH_IGNORED,
    depth: 0,
    ignorePermissionErrors: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 300 },
  });
  watcher.on("error", (err) => {
    // unreadable sockets/devices/etc. — non-fatal, keep the watcher alive
    console.warn("[ws-gate] watch error (ignored):", err.code ?? err.message);
  });
  watcher.on("all", () => {}); // ensure handle stays warm; routing is done below
  globalWatchers.set(abs, { watcher, lastUse: Date.now() });
  return watcher;
}

function watchPath(conn, target) {
  const abs = assertAllowed(target, conn.principal.userId);
  if (!conn.watchers.has(abs)) {
    if (conn.watchers.size >= MAX_WATCHERS_PER_CONN) {
      throw Object.assign(new Error("watcher limit reached"), { code: "ELIMIT" });
    }
    const watcher = getSharedWatcher(abs);
    // route this directory's events to THIS connection
    let queued = new Set();
    let timer = null;
    const onAll = (_event, p) => {
      queued.add(p);
      if (!timer) timer = setTimeout(() => {
        timer = null;
        const events = [...queued].map((p2) => ({ path: p2 }));
        queued.clear();
        conn.sendJson({ type: "fs:event", watched: abs, events });
      }, 250);
    };
    watcher.on("all", onAll);
    conn.watchers.set(abs, { watcher, onAll });
  }
  return { watching: abs };
}

async function unwatchPath(conn, target) {
  const abs = path.resolve(target);
  const rec = conn.watchers.get(abs);
  if (rec) {
    try { rec.watcher.removeListener("all", rec.onAll); } catch {}
    conn.watchers.delete(abs);
  }
}

// ── WebSocket connections ───────────────────────────────────────────────────
/** @type {Set<any>} */
const connections = new Set();

function makeConn(ws) {
  const browserFrameFlow = new ViewerFrameFlow(
    ({ channelId, sequence, bytes }) => ws.send(encodeLiveFramePacket({
      type: LIVE_FRAME_PACKET_TYPE.watcherFrame, channelId, sequence, payload: bytes,
    })),
    () => ws.readyState === ws.OPEN && ws.bufferedAmount === 0,
  );
  return {
    id: randomBytes(8).toString("hex"),
    ws,
    principal: null,
    watchers: new Map(),
    /** terminal ids this connection forwards output for */
    attachedTo: new Set(),
    /** the session binary frames write to */
    focusId: null,
    /** id → forwarding fn registered into session.watchers (stable refs) */
    forwards: new Map(),
    /** id → cwd forwarding fn registered into session.cwdWatchers */
    cwdForwards: new Map(),
    /** id → ready forwarding fn registered into session.readyWatchers */
    readyForwards: new Map(),
    nextChannelId: 1,
    terminalToChannel: new Map(),
    channelToTerminal: new Map(),
    browserPeer: null,
    browserFrameFlow,
    browserSessionToChannel: new Map(),
    browserChannelToSession: new Map(),
    sendJson(obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); },
    sendTerminal(terminalId, bytes, replay = false) {
      if (ws.readyState !== ws.OPEN) return;
      const channelId = assignChannel(this, terminalId);
      const payload = Buffer.from(bytes);
      const frame = Buffer.allocUnsafe(6 + payload.byteLength);
      frame[0] = 1; frame[1] = replay ? 6 : 2; frame.writeUInt32BE(channelId, 2); payload.copy(frame, 6);
      ws.send(frame);
    },
    sendTerminalReset(terminalId) {
      if (ws.readyState !== ws.OPEN) return;
      const channelId = assignChannel(this, terminalId);
      const frame = Buffer.allocUnsafe(6);
      frame[0] = 1; frame[1] = 3; frame.writeUInt32BE(channelId, 2);
      ws.send(frame);
    },
    sendBrowserFrame(browserSessionId, sequence, bytes) {
      if (ws.readyState !== ws.OPEN) return;
      browserFrameFlow.offer({
        channelId: assignBrowserChannel(this, browserSessionId), sequence, bytes,
      });
    },
  };
}

function assignChannel(conn, terminalId) {
  const existing = conn.terminalToChannel.get(terminalId);
  if (existing) return existing;
  const channelId = conn.nextChannelId++;
  conn.terminalToChannel.set(terminalId, channelId);
  conn.channelToTerminal.set(channelId, terminalId);
  return channelId;
}

function assignBrowserChannel(conn, browserSessionId) {
  const existing = conn.browserSessionToChannel.get(browserSessionId);
  if (existing) return existing;
  const channelId = conn.nextChannelId++;
  conn.browserSessionToChannel.set(browserSessionId, channelId);
  conn.browserChannelToSession.set(channelId, browserSessionId);
  return channelId;
}

function requireOwnedTerminal(conn, id) {
  const session = terminals.get(id);
  if (!session || session.userId !== conn.principal?.userId) {
    throw Object.assign(new Error("no such terminal"), { code: "ENOSESSION" });
  }
  return session;
}

function detachTerminal(conn, id) {
  const session = terminals.get(id);
  const fwd = conn.forwards.get(id);
  const cwdFwd = conn.cwdForwards.get(id);
  const readyFwd = conn.readyForwards.get(id);
  if (session && fwd) session.watchers.delete(fwd);
  if (session && cwdFwd) session.cwdWatchers.delete(cwdFwd);
  if (session && readyFwd) session.readyWatchers.delete(readyFwd);
  conn.forwards.delete(id);
  conn.cwdForwards.delete(id);
  conn.readyForwards.delete(id);
  conn.attachedTo.delete(id);
  const channelId = conn.terminalToChannel.get(id);
  if (channelId) conn.channelToTerminal.delete(channelId);
  conn.terminalToChannel.delete(id);
  if (conn.focusId === id) conn.focusId = null;
}

function toWebProject(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    created: project.created,
    updated: project.updated,
  };
}

async function requireProject(id) {
  const project = typeof id === "string" ? await projectStore.get(id) : null;
  if (!project) throw Object.assign(new Error("项目不存在"), { code: "PROJECT_NOT_FOUND" });
  return project;
}

const requestHandlers = {
  "hello": async () => ({
    roots: roots.map((r) => ({ path: r, label: path.basename(r) || r })),
    home: os.homedir(),
    platform: process.platform,
  }),

  "term:start": async (msg, conn) => {
    const id = msg.id || `t-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    if (terminals.has(id)) requireOwnedTerminal(conn, id);
    const existingTabs = consoleStore.listTabs(conn.principal.userId);
    const existingTab = existingTabs.find((tab) => tab.id === id);
    const liveCount = existingTabs.filter((tab) => tab.status === "active" || tab.status === "detached").length;
    if (!existingTab && liveCount >= 8) throw Object.assign(new Error("terminal limit reached"), { code: "ELIMIT" });
    const session = startTerminal(id, { ...msg, userId: conn.principal.userId });
    detachTerminal(conn, id); // idempotent re-attach

    const channelId = assignChannel(conn, id);
    const now = new Date().toISOString();
    if (!existingTab) consoleStore.createTab({ id, userId: conn.principal.userId, title: msg.title || `Terminal ${existingTabs.length + 1}`, shell: session.shell, startCwd: session.cwd || os.homedir(), currentCwd: session.cwd || os.homedir(), status: "active", sortOrder: existingTabs.length, createdAt: now, lastActiveAt: now, exitedAt: null, closedAt: null });
    else consoleStore.updateTab(id, conn.principal.userId, { status: "active", lastActiveAt: now, exitedAt: null, closedAt: null });

    const forward = (bytes) => conn.sendTerminal(id, bytes);
    session.watchers.add(forward);
    conn.forwards.set(id, forward);
    conn.attachedTo.add(id);
    conn.focusId = id;

    // forward cwd changes so the UI file tree can follow the terminal
    const cwdForward = (cwd) => {
      conn.sendJson({ type: "term:cwd", id, cwd });
    };
    session.cwdWatchers.add(cwdForward);
    conn.cwdForwards.set(id, cwdForward);

    const readyForward = () => conn.sendJson({ type: "term:ready", id });
    if (!session.ready) {
      session.readyWatchers.add(readyForward);
      conn.readyForwards.set(id, readyForward);
    }

    // best-effort immediate cwd (shell may not have cd'd yet → home)
    let currentCwd = session.cwd;
    try {
      const detectedCwd = await readProcessCwd(session.pid);
      if (detectedCwd) currentCwd = session.cwd = detectedCwd;
    } catch {}

    // Queue replay after the RPC response. WebSocket frame ordering then lets a
    // new client install its channel subscription before reset + scrollback.
    setImmediate(() => {
      if (!conn.attachedTo.has(id)) return;
      conn.sendTerminalReset(id);
      const snap = session.scrollback.snapshot();
      if (snap.byteLength > 0) conn.sendTerminal(id, new Uint8Array(snap), msg.replayFrames === true);
    });
    return { sessionId: id, channelId, cols: session.size.cols, rows: session.size.rows, cwd: currentCwd, ready: session.ready };
  },

  "term:list": async (_msg, conn) => ({ tabs: consoleStore.listTabs(conn.principal.userId) }),

  "term:rename": async (msg, conn) => {
    requireOwnedTerminal(conn, msg.id);
    consoleStore.updateTab(msg.id, conn.principal.userId, { title: String(msg.title || "Terminal").slice(0, 80), lastActiveAt: new Date().toISOString() });
    return { id: msg.id, title: String(msg.title || "Terminal").slice(0, 80) };
  },

  "term:reorder": async (msg, conn) => {
    const ids = Array.isArray(msg.ids) ? msg.ids : [];
    ids.forEach((id, index) => { requireOwnedTerminal(conn, id); consoleStore.updateTab(id, conn.principal.userId, { sortOrder: index }); });
    return { ids };
  },

  "term:cwd": async (msg, conn) => {
    const session = requireOwnedTerminal(conn, msg.id || "");
    const cwd = await readProcessCwd(session.pid);
    return { cwd };
  },

  "term:set-cwd": async (msg, conn) => { const session=requireOwnedTerminal(conn,msg.id||conn.focusId||"");const cwd=String(msg.cwd||"");if(!cwd)throw Object.assign(new Error("invalid cwd"),{code:"EINVAL"});session.cwd=cwd;consoleStore.updateTab(session.id,session.userId,{currentCwd:cwd,lastActiveAt:new Date().toISOString()});return{cwd}; },

  "term:focus": async (msg, conn) => {
    const session = requireOwnedTerminal(conn, msg.id);
    if (session.inputOwner && session.inputOwner !== conn.id && !msg.force) throw Object.assign(new Error("terminal input owned by another device"), { code: "EWRITELOCK" });
    session.inputOwner = conn.id;
    conn.focusId = msg.id;
    return { focusId: msg.id, writeOwner: conn.id };
  },

  "term:request-write": async (msg, conn) => { const session = requireOwnedTerminal(conn, msg.id); session.inputOwner = conn.id; conn.focusId = msg.id; return { focusId: msg.id, writeOwner: conn.id }; },

  "term:input": async (msg, conn) => {
    const id = msg.id || conn.focusId;
    const session = requireOwnedTerminal(conn, id || "");
    if (session.inputOwner && session.inputOwner !== conn.id) throw Object.assign(new Error("terminal is read-only"), { code: "EWRITELOCK" });
    session.inputOwner = conn.id;
    session.pty.write(String(msg.data ?? ""));
    return null;
  },

  "term:resize": async (msg, conn) => {
    const id = msg.id || conn.focusId;
    if (!id) return null;
    const session = requireOwnedTerminal(conn, id);
    const cols = clampInt(msg.cols, 2, 500, session.size.cols);
    const rows = clampInt(msg.rows, 2, 300, session.size.rows);
    session.size = { cols, rows };
    try { session.pty.resize(cols, rows); } catch {}
    return null;
  },

  "term:detach": async (msg, conn) => {
    const id = msg.id || conn.focusId;
    if (id) { requireOwnedTerminal(conn, id); detachTerminal(conn, id); }
    return null;
  },

  "ping": async () => ({ pong: true, t: Date.now() }),

  "browser:list": async (_msg, conn) => ({ sessions: liveViewRegistry.list(conn.browserPeer) }),
  "browser:publish": async (msg, conn) => {
    const session = liveViewRegistry.publish(conn.browserPeer, msg);
    return { session, channelId: assignBrowserChannel(conn, session.id) };
  },
  "browser:frame": async (msg, conn) => liveViewRegistry.updateFrame(conn.browserPeer, {
    ...msg,
    data: typeof msg.data === "string" ? Buffer.from(msg.data, "base64") : msg.data,
  }),
  "browser:watch": async (msg, conn) => {
    conn.browserFrameFlow.reset(msg.frameAck === true);
    const session = liveViewRegistry.watch(conn.browserPeer, msg.sessionId);
    return { session, channelId: assignBrowserChannel(conn, session.id) };
  },
  "browser:frame-ack": async (msg, conn) => {
    conn.browserFrameFlow.ack(msg.channelId, msg.sequence);
    return { accepted: true };
  },
  "browser:unwatch": async (_msg, conn) => {
    conn.browserFrameFlow.reset(false);
    return liveViewRegistry.unwatch(conn.browserPeer);
  },
  "browser:takeover": async (msg, conn) => ({ session: liveViewRegistry.takeOver(conn.browserPeer, msg.sessionId) }),
  "browser:return": async (msg, conn) => ({ session: liveViewRegistry.returnControl(conn.browserPeer, msg.sessionId) }),
  "browser:input": async (msg, conn) => {
    // Waits (briefly) for the producer's dispatch result — e.g. the desktop
    // helper's hit-test of a tapped element — so the viewer gets it in the
    // rpc reply. Producers that never reply resolve to null.
    const result = await liveViewRegistry.input(conn.browserPeer, msg.sessionId, msg.input);
    return result ? { input: result } : { accepted: true };
  },
  "browser:input-result": async (msg, conn) => liveViewRegistry.inputResult(conn.browserPeer, msg.sessionId, msg.token, msg.result),
  "browser:set-display": async (msg, conn) => ({ session: liveViewRegistry.setDisplay(conn.browserPeer, msg.sessionId, msg.displayId) }),
  // Latency probe for the live panel's readout.
  "browser:ping": async (msg) => ({ t: typeof msg.t === "number" ? msg.t : 0 }),
  // WebRTC signaling viewer→producer (offer request, answer, ICE, stop)
  "browser:webrtc": async (msg, conn) => liveViewRegistry.webrtcFromViewer(conn.browserPeer, msg.sessionId, msg.data),
  // WebRTC signaling producer→controller (offer, ICE, state)
  "browser:webrtc-relay": async (msg, conn) => liveViewRegistry.webrtcFromProducer(conn.browserPeer, msg.sessionId, msg.data),
  "browser:producer-state": async (msg, conn) => ({ session: liveViewRegistry.producerState(conn.browserPeer, msg.sessionId, msg.state) }),
  "browser:close": async (msg, conn) => { liveViewRegistry.close(conn.browserPeer, msg.sessionId); return { closed: true, sessionId: msg.sessionId }; },
  // Lock / wake / remote unlock of this machine (Windows unlock service).
  // The password lives only inside this RPC round-trip: audit logs record the
  // operation type, never the payload.
  "browser:system": async (msg) => ({ result: await remoteAuthorization.systemAction(String(msg.action || ""), {
    sessionId: typeof msg.sessionId === "string" ? msg.sessionId : undefined,
    password: typeof msg.password === "string" ? msg.password : undefined,
  }) }),

  "project:list": async () => ({
    projects: (await projectStore.list()).map(toWebProject),
  }),

  "project:get": async (msg) => ({
    project: toWebProject(await requireProject(msg.projectId)),
  }),

  "project:create": async (msg) => {
    const canonical = hostPathPolicy.assertDirectory(String(msg.path ?? ""));
    const projects = await projectStore.list();
    for (const existing of projects) {
      try {
        if (hostPathPolicy.assertDirectory(existing.description) === canonical) {
          return { project: toWebProject(existing), existing: true };
        }
      } catch {}
    }
    const now = new Date().toISOString();
    const requestedName = typeof msg.name === "string" ? msg.name.trim() : "";
    const project = await projectStore.create({
      id: randomUUID(),
      name: requestedName || path.basename(canonical) || canonical,
      description: canonical,
      created: now,
      updated: now,
    });
    return { project: toWebProject(project), existing: false };
  },

  "project:rename": async (msg) => {
    await requireProject(msg.projectId);
    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    if (!name) throw Object.assign(new Error("项目名称不能为空"), { code: "PROJECT_NAME_REQUIRED" });
    return { project: toWebProject(await projectStore.update(msg.projectId, { name })) };
  },

  "project:delete": async (msg) => {
    await requireProject(msg.projectId);
    await projectStore.delete(msg.projectId);
    return { deleted: true, projectId: msg.projectId };
  },

  "project:roots": async () => ({ roots: hostPathPolicy.roots }),

  "project:directories": async (msg) => ({
    path: hostPathPolicy.assertDirectory(String(msg.path ?? "")),
    entries: hostPathPolicy.listDirectories(String(msg.path ?? "")),
  }),

  "project:check": async (msg) => {
    try {
      return { valid: true, path: hostPathPolicy.assertDirectory(String(msg.path ?? "")) };
    } catch (error) {
      return { valid: false, error: error.message, code: error.code };
    }
  },

  "term:kill": async (msg, conn) => {
    const id = msg.id || conn.focusId;
    if (!id) return null;
    const session = requireOwnedTerminal(conn, id);
    session.closed = true;
    try { session.pty.kill(); } catch {}
    consoleStore.updateTab(id, conn.principal.userId, { status: "closed", closedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() });
    detachTerminal(conn, id);
    // Acknowledge (not fire-and-forget) so a client awaiting this rpc resolves
    // immediately instead of hanging until its 15s timeout.
    return { closed: true };
  },

  "fs:list": async (msg, conn) => ({ entries: await fsList(msg.path, conn.principal.userId) }),
  "fs:read": async (msg, conn) => await fsRead(msg.path, msg.offset ?? 0, msg.length, conn.principal.userId),

  // ── AI Hub：转发到桌面端 App（已登录 WebContentsView 注入）──
  "aihub:status": async () => await aiHubRelayStatus(),
  "aihub:capture": async (msg) => {
    const siteIds = Array.isArray(msg.siteIds) ? msg.siteIds.map((id) => String(id)).filter(Boolean).slice(0, MAX_RELAY_SITES) : [];
    if (siteIds.length === 0) throw Object.assign(new Error("no sites"), { code: "EINVAL" });
    return aiHubRelayCapture(siteIds);
  },
  "aihub:send": async (msg) => {
    const text = String(msg.text ?? "").slice(0, MAX_RELAY_TEXT_LENGTH);
    const siteIds = Array.isArray(msg.siteIds) ? msg.siteIds.map((id) => String(id)).filter(Boolean).slice(0, MAX_RELAY_SITES) : [];
    // 图片：data:image/*;base64 数据 URL，最多 MAX_RELAY_IMAGES 张，单张截断到
    // MAX_RELAY_IMAGE_LENGTH 个 base64 字符（桌面端还会再校验）
    const images = Array.isArray(msg.images)
      ? msg.images
        .filter((item) => typeof item === "string" && item.startsWith("data:image/"))
        .map((item) => item.slice(0, MAX_RELAY_IMAGE_LENGTH))
        .slice(0, MAX_RELAY_IMAGES)
      : [];
    if (!text.trim() && images.length === 0) throw Object.assign(new Error("empty text"), { code: "EINVAL" });
    if (siteIds.length === 0) throw Object.assign(new Error("no sites"), { code: "EINVAL" });
    return aiHubRelayBroadcast(text, siteIds, images);
  },
  "fs:inspect-text": async (msg, conn) => await inspectTextFile(assertAllowed(msg.path, conn.principal.userId)),
  "fs:inspect-text-status": async (msg, conn) => await inspectTextFileStatus(assertAllowed(msg.path, conn.principal.userId)),
  "fs:write-text": async (msg, conn) => await saveTextFile(
    assertAllowed(msg.path, conn.principal.userId),
    msg.content,
    { size: msg.expectedSize, mtime: msg.expectedMtime },
  ),
  "fs:stat": async (msg, conn) => {
    const st = await fsp.stat(assertAllowed(msg.path, conn.principal.userId));
    return { size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() };
  },
  "fs:watch": async (msg, conn) => watchPath(conn, msg.path),
  "fs:unwatch": async (msg, conn) => { await unwatchPath(conn, msg.path); return null; },

  "fs:preview-open": async (msg, conn) => {
    const abs = assertAllowed(msg.path, conn.principal.userId);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "EISDIR" });
    const ticketId = previewTickets.issue(abs, conn.principal.userId);
    return {
      ticketId,
      url: `/api/web-console/file-preview/${ticketId}`,
      size: st.size,
      mtime: st.mtimeMs,
      mime: mimeFor(abs),
    };
  },
  "fs:preview-close": async (msg, conn) => ({
    revoked: previewTickets.revoke(String(msg.ticketId ?? ""), conn.principal.userId),
  }),

  "fs:download": async (msg, conn) => {
    // small-file download convenience (≤1 MiB) as base64 data URL payload
    const result = await fsRead(msg.path, 0, 1024 * 1024, conn.principal.userId);
    return result;
  },

  "fs:dataurl": async (msg, conn) => {
    // rich media (image/video/audio/pdf): whole file as a data URL for
    // native browser rendering. Cap at 16 MiB — bigger videos won't fit
    // a WS frame comfortably.
    const abs = assertAllowed(msg.path, conn.principal.userId);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "EISDIR" });
    if (st.size > 16 * 1024 * 1024) {
      throw Object.assign(new Error(`file too large for inline preview (${(st.size / 1048576).toFixed(1)} MiB)`), { code: "ETOOLARGE" });
    }
    const buf = await fsp.readFile(abs);
    return {
      mime: mimeFor(msg.path),
      data: buf.toString("base64"),
      size: st.size,
      mtime: st.mtimeMs,
    };
  },
};

let reqSeq = 0;

async function handleMessage(conn, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString("utf8"));
  } catch {
    return conn.sendJson({ type: "error", error: "bad json frame" });
  }
  if (!msg || typeof msg.type !== "string") {
    return conn.sendJson({ type: "error", error: "missing type" });
  }
  const handler = Object.hasOwn(requestHandlers, msg.type) ? requestHandlers[msg.type] : null;
  if (!handler) {
    return conn.sendJson({ type: "error", error: `unknown type: ${msg.type}` });
  }
  const sensitive = /^(?:term:(?:start|input|close|kill|focus|request-write|set-cwd)|fs:|file:|browser:(?:input|takeover|system)|aihub:|project:(?:create|rename|delete))/.test(msg.type);
  try {
    if (sensitive) pairingGateway.auditOperation(conn.principal, `ws.${msg.type}`, "started");
    const result = await handler(msg, conn);
    if (sensitive) pairingGateway.auditOperation(conn.principal, `ws.${msg.type}`, "success");
    if (result === null) return; // fire-and-forget commands
    // NOTE: correlation id must win — spread result FIRST so a business
    // payload field named `id` can never clobber the request's numeric id.
    conn.sendJson({ ...(result ?? {}), type: `${msg.type}:result`, id: msg._req ?? ++reqSeq });
  } catch (err) {
    if (sensitive) pairingGateway.auditOperation(conn.principal, `ws.${msg.type}`, "failed");
    conn.sendJson({
      type: "error",
      id: msg._req,
      error: err.message,
      code: err.code,
      inReplyTo: `${msg.type}:result`,
    });
  }
}

// ── wire Next.js + WS onto one HTTP server ──────────────────────────────────
const app = next({ dev, dir });
const handle = app.getRequestHandler();

await app.prepare();

// ── static hosting for the web shell (@agent/webapp build) at /app ─────────
// Built by `bun run --cwd packages/webapp build`; override the artifact dir
// with AGENT_WEB_APP_DIST when staging for the CLI/tunnel runtime.
// Resolution order: env override → staged CLI runtime layout → repo workspace.
const webAppDistCandidates = [
  process.env.AGENT_WEB_APP_DIST?.trim(),
  path.join(dir, "webapp", "dist"),
  path.join(dir, "..", "webapp", "dist"),
].filter(Boolean).map((candidate) => path.resolve(candidate));
const webAppDist = webAppDistCandidates.find((candidate) => fsSync.existsSync(candidate))
  ?? webAppDistCandidates[webAppDistCandidates.length - 1];

// Build id = entry chunk filename; clients compare against their own script
// URL and force-reload themselves when a newer build has been deployed.
let webAppBuildId = "";
function refreshWebAppBuildId() {
  try {
    const html = fsSync.readFileSync(path.join(webAppDist, "index.html"), "utf8");
    const match = html.match(/assets\/(index-[^"']+\.js)/);
    if (match) {
      webAppBuildId = match[1];
      globalThis.__webAppBuildId = webAppBuildId;
    }
  } catch { /* keep previous */ }
}
refreshWebAppBuildId();
setInterval(refreshWebAppBuildId, 30000);

const WEB_APP_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

async function serveWebApp(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/app" && !url.pathname.startsWith("/app/")) return false;
  const remoteAddr = req.socket.remoteAddress;
  // The build uses relative asset URLs — redirect to the trailing-slash form
  // so ./assets/... resolves under /app/ instead of the site root.
  if (url.pathname === "/app") {
    console.log(`[web-app] ${remoteAddr} → /app (redirect)`);
    res.writeHead(301, { location: "/app/" + url.search }).end();
    return true;
  }
  const relative = url.pathname.replace(/^\/app\/?/, "") || "index.html";
  if (relative === "index.html") console.log(`[web-app] ${remoteAddr} → /app/ shell`);
  let filePath = path.resolve(webAppDist, relative);
  if (filePath !== webAppDist && !filePath.startsWith(webAppDist + path.sep)) {
    res.writeHead(403).end();
    return true;
  }
  try {
    const stats = await fsp.stat(filePath);
    if (stats.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    // Unknown extension-less path → shell (deep links); missing assets → 404.
    if (!path.extname(relative)) filePath = path.join(webAppDist, "index.html");
    else {
      res.writeHead(404).end("Not found");
      return true;
    }
  }
  try {
    let data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      "content-type": WEB_APP_MIME[ext] || "application/octet-stream",
      // Hashed filenames change per build — never let devices pin old bundles.
      "cache-control": "no-cache",
    };
    // Compress the big text assets — remote links (tailscale relay, tunnels)
    // are the slow path for phones.
    const compressible = [".js", ".mjs", ".css", ".html", ".json", ".svg", ".map"].includes(ext)
      && String(req.headers["accept-encoding"] || "").includes("gzip")
      && data.length > 1024;
    if (compressible) {
      data = zlib.gzipSync(data);
      headers["content-encoding"] = "gzip";
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
  return true;
}

// HTML deliverables run with a unique opaque origin (CSP `sandbox`, no
// allow-same-origin): scripts execute, but the page can never touch the
// console origin's storage, cookies or same-origin APIs — even when the
// ticket URL is opened as a top-level browser tab.
const HTML_PREVIEW_CSP = "sandbox allow-scripts allow-popups allow-forms allow-modals";
const MARKDOWN_PREVIEW_CSP = [
  "sandbox allow-popups allow-forms",
  "default-src 'none'",
  "img-src 'self' data: https: http:",
  "media-src 'self' https: http:",
  "style-src 'unsafe-inline'",
].join("; ");

async function serveTicketedFilePreview(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const prefix = "/api/web-console/file-preview/";
  if (!url.pathname.startsWith(prefix)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return true;
  }
  const [ticketId, ...relativeSegments] = url.pathname.slice(prefix.length).split("/");
  const ticket = ticketId ? previewTickets.resolve(ticketId) : null;
  if (!ticket) {
    res.writeHead(404, { "cache-control": "private, no-store" }).end("Not found");
    return true;
  }
  try {
    const primary = assertAllowed(ticket.path, ticket.userId);
    let target = primary;
    let extraHeaders = {};
    if (relativeSegments.length > 0) {
      // Sub-path → a relative resource (css/js/img/…) referenced by the
      // previewed HTML, resolved against the deliverable's own directory.
      const relative = relativeSegments.map(decodeURIComponent).join("/");
      target = assertAllowed(path.resolve(path.dirname(primary), relative), ticket.userId);
    }
    if (relativeSegments.length > 0 && target === primary && isMarkdownPreviewPath(primary)) {
      await serveMarkdownPreview(req, res, primary, { "content-security-policy": MARKDOWN_PREVIEW_CSP });
      return true;
    }
    if (mimeFor(target).startsWith("text/html")) {
      extraHeaders = { "content-security-policy": HTML_PREVIEW_CSP };
    }
    await servePreviewFile(req, res, target, mimeFor(target), extraHeaders);
  } catch (error) {
    if (!res.headersSent) {
      const status = error?.code === "EACCES" || error?.code === "EPATH_NOT_ALLOWED" ? 403 : 404;
      res.writeHead(status, { "cache-control": "private, no-store" }).end("Not found");
    } else {
      res.destroy(error);
    }
  }
  return true;
}

const desktopDiscovery = createDesktopDiscovery({ dataDir: serverBaseDir });
const pairingGateway = createDevicePairingGateway({ dataDir: serverBaseDir, desktop: desktopDiscovery, owner: anonymousWebStore.getOrCreatePrincipal(), consoleStore, testNoPairing: process.argv.includes("--test-no-pairing") });
if (process.argv.includes("--test-no-pairing")) console.warn("[TEST MODE] 配对已跳过：能访问此端口的用户可直接操作。仅用于受控测试，移除 --test-no-pairing 后恢复认证。");
// Child runtimes may publish live frames only using this process's local credential.
process.env.AGENTROAM_LOCAL_SERVICE_TOKEN = desktopDiscovery.headers()["x-agentroam-desktop-token"];
const remoteAuthorization = new RemoteAuthorization({ registry: liveViewRegistry, userId: anonymousWebStore.getOrCreatePrincipal().userId, dataDir: serverBaseDir });
await remoteAuthorization.initialize();
let serviceReady = false;
const server = createServer((req, res) => {
  if (!serviceReady) { res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "Service starting" })); return; }
  if (desktopDiscovery.handle(req, res)) return;
  void pairingGateway.handle(req, res)
    .then((handled) => handled || remoteAuthorization.handle(req, res))
    .then((handled) => handled || serveTicketedFilePreview(req, res))
    .then((handled) => handled || serveWebApp(req, res))
    .then((handled) => { if (!handled) handle(req, res); })
    .catch((error) => {
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
      else res.destroy(error);
    });
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const principal = url.pathname === "/ws" ? pairingGateway.authenticateUpgrade(req) : null;
  if (!principal) { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    pairingGateway.track(ws, principal);
    wss.emit("connection", ws, req, principal);
  });
});

wss.on("connection", (ws, _req, principal) => {
  const conn = makeConn(ws);
  conn.principal = principal;
  conn.browserPeer = {
    id: conn.id,
    userId: principal.userId,
    send: (event) => {
      if (event.type === "browser:frame" && event.data instanceof Uint8Array) {
        conn.sendBrowserFrame(event.sessionId, event.sequence, event.data);
      } else {
        conn.sendJson(event);
      }
    },
    producerSessionIds: new Set(),
    watchedSessionId: null,
  };
  liveViewRegistry.connect(conn.browserPeer);
  connections.add(conn);
  conn.sendJson({ type: "connection:hello", userId: principal.userId, deviceId: principal.deviceId });

  ws.on("message", (data, isBinary) => {
    if (!pairingGateway.active(principal)) { ws.close(4003, "device authorization expired"); return; }
    if (isBinary) {
      const frame = Buffer.from(data);
      const livePacket = readLiveFramePacket(frame);
      if (livePacket && livePacket.type === LIVE_FRAME_PACKET_TYPE.producerFrame) {
        const browserSessionId = conn.browserChannelToSession.get(livePacket.channelId);
        if (!browserSessionId) return;
        try {
          liveViewRegistry.updateFrame(conn.browserPeer, {
            sessionId: browserSessionId,
            sequence: livePacket.sequence,
            data: livePacket.payload,
          });
        } catch (error) {
          conn.sendJson({ type: "browser:frame-rejected", sessionId: browserSessionId, error: error.message, code: error.code });
        }
        return;
      }
      if (frame.byteLength < 6 || frame[0] !== 1 || frame[1] !== 1) return;
      const terminalId = conn.channelToTerminal.get(frame.readUInt32BE(2));
      if (!terminalId) return;
      // Input frames race the terminal's own close (in-flight keystrokes while
      // the tab tears down) — drop them silently instead of throwing.
      const session = terminals.get(terminalId);
      if (!session || session.exited || session.userId !== conn.principal?.userId) return;
      try {
        if (session.inputOwner && session.inputOwner !== conn.id) { pairingGateway.auditOperation(conn.principal, "ws.term:input", "denied"); return; }
        pairingGateway.auditOperation(conn.principal, "ws.term:input", "started");
      } catch { ws.close(1011, "Security audit unavailable"); return; }
      session.inputOwner = conn.id;
      session.pty.write(frame.subarray(6).toString("utf8"));
      return;
    }
    handleMessage(conn, data).catch((err) => conn.sendJson({ type: "error", error: err.message }));
  });

  ws.on("close", () => {
    conn.browserFrameFlow.reset(false);
    // Close an established peer-to-peer media path as well as the relay socket.
    // Signaling must be sent before disconnect releases the controller identity.
    if (conn.browserPeer.watchedSessionId) {
      try { liveViewRegistry.webrtcFromViewer(conn.browserPeer, conn.browserPeer.watchedSessionId, { kind: "stop" }); } catch { /* read-only viewer */ }
    }
    liveViewRegistry.disconnect(conn.browserPeer);
    connections.delete(conn);
    for (const id of [...conn.attachedTo]) {
      const session = terminals.get(id);
      detachTerminal(conn, id);
      if (session?.inputOwner === conn.id) session.inputOwner = null;
      if (session && session.watchers.size === 0 && !session.exited) consoleStore.updateTab(id, session.userId, { status: "detached", lastActiveAt: new Date().toISOString() });
    }
    for (const [, rec] of conn.watchers) {
      try { rec.watcher.removeListener("all", rec.onAll); } catch {}
    }
    conn.watchers.clear();
  });
});

server.on("close", () => { void remoteAuthorization.close(); pairingGateway.close(); void desktopDiscovery.close(); });
server.listen(port, process.env.HOST || "127.0.0.1", async () => {
  process.env.AGENTROAM_LOCAL_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    await desktopDiscovery.publish(server.address().port);
    serviceReady = true;
  } catch {
    console.error("Desktop service discovery could not be published");
    server.close();
    return;
  }
  // Load the server-owned Customer runtime (including persisted schedules)
  // without requiring a desktop/browser visit after a service restart.
  void fetch(`http://127.0.0.1:${server.address().port}/api/agent/model`, {
    signal: AbortSignal.timeout(60_000),
    headers: desktopDiscovery.headers(),
  }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }).catch((error) => console.error("Customer runtime initialization failed", error));
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) urls.push(`http://${net.address}:${port}/web`);
    }
  }
  console.log(`▲ AgentRoam web gateway`);
  console.log(`   local    http://localhost:${port}/web`);
  for (const u of (process.env.HOST === "0.0.0.0" ? urls : [])) console.log(`   network  ${u}`);
  console.log(`   auth     device pairing required (agentroam pair)`);
  console.log(`   roots    ${roots.join(" : ")}`);
});
