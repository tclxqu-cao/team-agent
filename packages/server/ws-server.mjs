#!/usr/bin/env node
// ws-server.mjs — custom server for @agent/server.
// Serves the Next.js app (API + /web console) and multiplexes a WebSocket
// channel on the SAME port for the remote terminal (PTY) and file services.
//
// Frame protocol:
//   binary frames        → raw PTY bytes for the focused terminal
//   text frames (JSON)   → control protocol ({type, ...} / {type:"...:result", id})
//
// Auth: token required on /ws upgrade (?token=...). Set AGENT_WEB_TOKEN to
// pin it; otherwise a random token is generated and printed at boot.
//
// Env:
//   PORT              HTTP/WS port           (default 3000)
//   AGENT_WEB_TOKEN   fixed access token     (default: random per boot)
//   AGENT_WEB_ROOTS   ":"-separated dirs the file APIs may touch (default: $HOME)

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import next from "next";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import chokidar from "chokidar";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const dir = path.dirname(new URL(import.meta.url).pathname);

const token = process.env.AGENT_WEB_TOKEN || randomBytes(16).toString("hex");
const roots = (process.env.AGENT_WEB_ROOTS || os.homedir())
  .split(":")
  .map((p) => path.resolve(p.trim()))
  .filter(Boolean);

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
 * @typedef {{id:string, pid:number, cwd:string|null, pty:import('node-pty').IPty, scrollback:Scrollback,
 *            size:{cols:number,rows:number}, watchers:Set<(b:Uint8Array)=>void>,
 *            exited:boolean, cwdWatchers:Set<(cwd:string)=>void>}} TerminalSession
 */

/** @returns {TerminalSession} */
function startTerminal(id, { cols = 80, rows = 24, cwd, command } = {}) {
  const existing = terminals.get(id);
  if (existing && !existing.exited) return existing;

  const shell = process.env.SHELL || "/bin/zsh";
  const args = command ? ["-l", "-c", command] : ["-l"];
  const p = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: clampInt(cols, 2, 500, 80),
    rows: clampInt(rows, 2, 300, 24),
    cwd: cwd && fsSync.existsSync(cwd) ? cwd : os.homedir(),
    env: process.env,
  });

  /** @type {TerminalSession} */
  const session = {
    id,
    pid: p.pid,
    cwd: null,
    pty: p,
    scrollback: new Scrollback(),
    size: { cols, rows },
    watchers: new Set(),
    cwdWatchers: new Set(),
    exited: false,
  };
  watchTerminalCwd(session, (cwd2) => {
    session.cwd = cwd2;
    for (const cb of [...session.cwdWatchers]) {
      try { cb(cwd2); } catch {}
    }
  });

  p.onData((data) => {
    const copy = session.scrollback.append(data);
    for (const send of [...session.watchers]) {
      try { send(new Uint8Array(copy)); } catch {}
    }
  });
  p.onExit(({ exitCode }) => {
    session.exited = true;
    for (const cb of [...session.cwdWatchers]) {
      try { cb(null); } catch {}
    }
    session.cwdWatchers.clear();
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
  return session;
}

// ── filesystem service (read-only V1) ───────────────────────────────────────
function assertAllowed(absPath) {
  const resolved = path.resolve(absPath);
  // Static configured roots + current directories of active PTY sessions.
  // The user can already access these paths through the terminal; this keeps
  // the file manager aligned with terminal navigation without opening `/`
  // globally when the terminal still lives under $HOME.
  const activeCwds = [...terminals.values()].map((s) => s.cwd).filter(Boolean);
  const allowedRoots = [...roots, ...activeCwds];
  const allowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!allowed) throw Object.assign(new Error(`path outside allowed roots`), { code: "EPATH" });
  return resolved;
}

async function fsList(dirPath) {
  const abs = assertAllowed(dirPath);
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
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", m4v: "video/x-m4v",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg",
  pdf: "application/pdf",
};

function mimeFor(p) {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

async function fsRead(filePath, offset = 0, length = MAX_READ_CHUNK) {
  const abs = assertAllowed(filePath);
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
  const abs = assertAllowed(target);
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
  return {
    ws,
    watchers: new Map(),
    /** terminal ids this connection forwards output for */
    attachedTo: new Set(),
    /** the session binary frames write to */
    focusId: null,
    /** id → forwarding fn registered into session.watchers (stable refs) */
    forwards: new Map(),
    /** id → cwd forwarding fn registered into session.cwdWatchers */
    cwdForwards: new Map(),
    sendJson(obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); },
    sendBinary(bytes) { if (ws.readyState === ws.OPEN) ws.send(bytes); },
  };
}

function detachTerminal(conn, id) {
  const session = terminals.get(id);
  const fwd = conn.forwards.get(id);
  const cwdFwd = conn.cwdForwards.get(id);
  if (session && fwd) session.watchers.delete(fwd);
  if (session && cwdFwd) session.cwdWatchers.delete(cwdFwd);
  conn.forwards.delete(id);
  conn.cwdForwards.delete(id);
  conn.attachedTo.delete(id);
  if (conn.focusId === id) conn.focusId = null;
}

const requestHandlers = {
  "hello": async () => ({
    roots: roots.map((r) => ({ path: r, label: path.basename(r) || r })),
    home: os.homedir(),
    platform: process.platform,
  }),

  "term:start": async (msg, conn) => {
    const id = msg.id || `t-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    const session = startTerminal(id, msg);
    detachTerminal(conn, id); // idempotent re-attach

    const forward = (bytes) => conn.sendBinary(bytes);
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

    // replay scrollback to restore the screen after reconnect
    const snap = session.scrollback.snapshot();
    if (snap.byteLength > 0) setImmediate(() => conn.sendBinary(new Uint8Array(snap)));

    // best-effort immediate cwd (shell may not have cd'd yet → home)
    let currentCwd = null;
    try {
      currentCwd = await readProcessCwd(session.pid);
      session.cwd = currentCwd;
    } catch {}
    return { sessionId: id, cols: session.size.cols, rows: session.size.rows, cwd: currentCwd };
  },

  "term:cwd": async (msg) => {
    const session = terminals.get(msg.id || "") ;
    if (!session) throw Object.assign(new Error("no such terminal"), { code: "ENOSESSION" });
    const cwd = await readProcessCwd(session.pid);
    return { cwd };
  },

  "term:focus": async (msg, conn) => {
    if (!terminals.has(msg.id)) throw Object.assign(new Error("no such terminal"), { code: "ENOSESSION" });
    conn.focusId = msg.id;
    return { focusId: msg.id };
  },

  "term:input": async (msg, conn) => {
    const id = msg.id || conn.focusId;
    const session = id && terminals.get(id);
    if (!session) throw Object.assign(new Error("no such terminal"), { code: "ENOSESSION" });
    session.pty.write(String(msg.data ?? ""));
    return null;
  },

  "term:resize": async (msg, conn) => {
    const id = msg.id || conn.focusId;
    const session = id && terminals.get(id);
    if (!session) return null;
    const cols = clampInt(msg.cols, 2, 500, session.size.cols);
    const rows = clampInt(msg.rows, 2, 300, session.size.rows);
    session.size = { cols, rows };
    try { session.pty.resize(cols, rows); } catch {}
    return null;
  },

  "term:detach": async (msg, conn) => {
    detachTerminal(conn, msg.id || conn.focusId);
    return null;
  },

  "term:kill": async (msg, conn) => {
    const id = msg.id || conn.focusId;
    const session = id && terminals.get(id);
    if (!session) return null;
    try { session.pty.kill(); } catch {}
    detachTerminal(conn, id);
    return null;
  },

  "fs:list": async (msg) => ({ entries: await fsList(msg.path) }),
  "fs:read": async (msg) => await fsRead(msg.path, msg.offset ?? 0, msg.length),
  "fs:stat": async (msg) => {
    const st = await fsp.stat(assertAllowed(msg.path));
    return { size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() };
  },
  "fs:watch": async (msg, conn) => watchPath(conn, msg.path),
  "fs:unwatch": async (msg, conn) => { await unwatchPath(conn, msg.path); return null; },

  "fs:download": async (msg, conn) => {
    // small-file download convenience (≤1 MiB) as base64 data URL payload
    const result = await fsRead(msg.path, 0, 1024 * 1024);
    return result;
  },

  "fs:dataurl": async (msg) => {
    // rich media (image/video/audio/pdf): whole file as a data URL for
    // native browser rendering. Cap at 16 MiB — bigger videos won't fit
    // a WS frame comfortably.
    const abs = assertAllowed(msg.path);
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
  const handler = requestHandlers[msg.type];
  if (!handler) {
    return conn.sendJson({ type: "error", error: `unknown type: ${msg.type}` });
  }
  try {
    const result = await handler(msg, conn);
    if (result === null) return; // fire-and-forget commands
    // NOTE: correlation id must win — spread result FIRST so a business
    // payload field named `id` can never clobber the request's numeric id.
    conn.sendJson({ ...(result ?? {}), type: `${msg.type}:result`, id: msg._req ?? ++reqSeq });
  } catch (err) {
    conn.sendJson({
      type: "error",
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

const AUTH_TIMEOUT_MS = 10_000;

const server = createServer((req, res) => handle(req, res));
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") return; // leave HMR etc. to Next's own listeners
  wss.handleUpgrade(req, socket, head, (ws) =>
    wss.emit("connection", ws, req, url.searchParams.get("token")),
  );
});

wss.on("connection", (ws, _req, queryToken) => {
  const conn = makeConn(ws);
  // Auth model: handshake accepts ANY connection; identity is established by
  // the first {type:"auth"} message (or a matching ?token= for legacy clients).
  // Wrong credentials → structured error + close code 4001, which browser JS
  // CAN observe (unlike HTTP 401 during handshake, which looks like a generic
  // network failure and made the token gate unreachable).
  let authenticated = queryToken === token;
  connections.add(conn);

  const killUnauthenticated = () => {
    try { ws.close(4001, "invalid token"); } catch {}
  };

  if (!authenticated) {
    conn.sendJson({ type: "auth:required", hint: "send {type:'auth', token}" });
    setTimeout(() => {
      if (!authenticated && ws.readyState === ws.OPEN) killUnauthenticated();
    }, AUTH_TIMEOUT_MS).unref?.();
  } else {
    conn.sendJson({ type: "auth:result", ok: true });
  }

  ws.on("message", (data, isBinary) => {
    if (!authenticated) {
      if (isBinary) return killUnauthenticated();
      let probe;
      try { probe = JSON.parse(data.toString("utf8")); } catch { return killUnauthenticated(); }
      if (probe?.type !== "auth" || probe.token !== token) {
        conn.sendJson({ type: "error", error: "invalid token", code: "EAUTH" });
        return killUnauthenticated();
      }
      authenticated = true;
      conn.sendJson({ type: "auth:result", ok: true });
      return;
    }

    if (isBinary) {
      const session = conn.focusId && terminals.get(conn.focusId);
      if (session) session.pty.write(Buffer.from(data).toString("utf8"));
      return;
    }
    handleMessage(conn, data).catch((err) => conn.sendJson({ type: "error", error: err.message }));
  });

  ws.on("close", () => {
    connections.delete(conn);
    for (const id of [...conn.attachedTo]) detachTerminal(conn, id);
    for (const [, rec] of conn.watchers) {
      try { rec.watcher.removeListener("all", rec.onAll); } catch {}
    }
    conn.watchers.clear();
  });
});

server.listen(port, () => {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) urls.push(`http://${net.address}:${port}/web`);
    }
  }
  console.log(`▲ customer-agent web gateway`);
  console.log(`   local    http://localhost:${port}/web`);
  for (const u of urls) console.log(`   network  ${u}`);
  console.log(`   token    ${token}${process.env.AGENT_WEB_TOKEN ? " (AGENT_WEB_TOKEN)" : " (ephemeral — pin via AGENT_WEB_TOKEN)"}`);
  console.log(`   roots    ${roots.join(" : ")}`);
});
