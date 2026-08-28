#!/usr/bin/env node
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
import { SQLiteAuthStore, SQLiteWebConsoleStore, WebAuthService } from "@agent/core";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const dir = path.dirname(new URL(import.meta.url).pathname);

const serverBaseDir = path.resolve(process.env.AGENT_DATA_DIR?.trim() || dir);
const webAuth = new WebAuthService(new SQLiteAuthStore(serverBaseDir));
const consoleStore = new SQLiteWebConsoleStore(serverBaseDir);
consoleStore.markStaleTerminalsExited(new Date().toISOString());
const roots = (process.env.AGENT_WEB_ROOTS || os.homedir())
  .split(path.delimiter)
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
 * @typedef {{id:string, userId:string, pid:number, cwd:string|null, pty:import('node-pty').IPty, scrollback:Scrollback,
 *            size:{cols:number,rows:number}, watchers:Set<(b:Uint8Array)=>void>,
 *            exited:boolean, closed:boolean, cwdWatchers:Set<(cwd:string)=>void>, inputOwner:string|null, oscTail:string}} TerminalSession
 */

/** @returns {TerminalSession} */
function startTerminal(id, { userId, cols = 80, rows = 24, cwd, command } = {}) {
  const existing = terminals.get(id);
  if (existing && !existing.exited) return existing;

  const shell = process.env.SHELL || (process.platform==="win32"?(process.env.COMSPEC||"powershell.exe"):"/bin/zsh");
  const powershell=/powershell|pwsh/i.test(shell);
  const args = command ? (powershell?["-NoLogo","-Command",command]:["-l","-c",command]) : (powershell?["-NoLogo"]:["-l"]);
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
    userId,
    pid: p.pid,
    cwd: null,
    pty: p,
    scrollback: new Scrollback(),
    size: { cols, rows },
    watchers: new Set(),
    cwdWatchers: new Set(),
    inputOwner: null,
    closed: false,
    oscTail: "",
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
    captureShellHistory(session, data);
    const copy = session.scrollback.append(data);
    for (const send of [...session.watchers]) {
      try { send(new Uint8Array(copy)); } catch {}
    }
  });
  p.onExit(({ exitCode }) => {
    session.exited = true;
    if (!session.closed) consoleStore.updateTab(session.id, session.userId, { status: "exited", exitedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() });
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
  if (shell.endsWith("zsh")) {
    const hook = `autoload -Uz add-zsh-hook; function __ca_hist_preexec(){ local c=$(printf '%s' "$1"|base64|tr -d '\\n'); local d=$(printf '%s' "$PWD"|base64|tr -d '\\n'); printf '\\033]633;C;%s;%s\\007' "$c" "$d"; }; add-zsh-hook preexec __ca_hist_preexec; clear`;
    setTimeout(() => { if (!session.exited) p.write(` ${hook}\r`); }, 350).unref?.();
  }
  if (powershell) {
    const integration=`function global:prompt { $e=[char]27; $b=[char]7; Write-Host -NoNewline ($e + ']7;file:///' + ($PWD.Path -replace '\\\\','/') + $b); 'PS ' + $PWD.Path + '> ' }`;
    setTimeout(()=>{if(!session.exited)p.write(`${integration}\r`);},350).unref?.();
  }
  return session;
}

function captureShellHistory(session, data) {
  const combined = session.oscTail + data;
  const regex = /\x1b]633;C;([^;\x07]+);([^\x07]+)\x07/g;
  let match;
  let lastEnd = 0;
  while ((match = regex.exec(combined))) {
    lastEnd = regex.lastIndex;
    try {
      const command = Buffer.from(match[1], "base64").toString("utf8");
      const cwd = Buffer.from(match[2], "base64").toString("utf8");
      if (command.trim()) consoleStore.addHistory(session.userId, session.id, command, cwd, new Date().toISOString());
    } catch {}
  }
  const lastEscape = combined.lastIndexOf("\x1b]");
  session.oscTail = lastEscape >= lastEnd ? combined.slice(lastEscape).slice(-4096) : "";
}

// ── filesystem service (read-only V1) ───────────────────────────────────────
function assertAllowed(absPath, userId) {
  const resolved = path.resolve(absPath);
  // Static configured roots + current directories of active PTY sessions.
  // The user can already access these paths through the terminal; this keeps
  // the file manager aligned with terminal navigation without opening `/`
  // globally when the terminal still lives under $HOME.
  const activeCwds = [...terminals.values()].filter((s) => s.userId === userId).map((s) => s.cwd).filter(Boolean);
  const allowedRoots = [...roots, ...activeCwds];
  const allowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!allowed) throw Object.assign(new Error(`path outside allowed roots`), { code: "EPATH" });
  return resolved;
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
    nextChannelId: 1,
    terminalToChannel: new Map(),
    channelToTerminal: new Map(),
    sendJson(obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); },
    sendTerminal(terminalId, bytes) {
      if (ws.readyState !== ws.OPEN) return;
      const channelId = assignChannel(this, terminalId);
      const payload = Buffer.from(bytes);
      const frame = Buffer.allocUnsafe(6 + payload.byteLength);
      frame[0] = 1; frame[1] = 2; frame.writeUInt32BE(channelId, 2); payload.copy(frame, 6);
      ws.send(frame);
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
  if (session && fwd) session.watchers.delete(fwd);
  if (session && cwdFwd) session.cwdWatchers.delete(cwdFwd);
  conn.forwards.delete(id);
  conn.cwdForwards.delete(id);
  conn.attachedTo.delete(id);
  const channelId = conn.terminalToChannel.get(id);
  if (channelId) conn.channelToTerminal.delete(channelId);
  conn.terminalToChannel.delete(id);
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
    if (terminals.has(id)) requireOwnedTerminal(conn, id);
    const existingTabs = consoleStore.listTabs(conn.principal.userId);
    const existingTab = existingTabs.find((tab) => tab.id === id);
    const liveCount = existingTabs.filter((tab) => tab.status === "active" || tab.status === "detached").length;
    if (!existingTab && liveCount >= 8) throw Object.assign(new Error("terminal limit reached"), { code: "ELIMIT" });
    const session = startTerminal(id, { ...msg, userId: conn.principal.userId });
    detachTerminal(conn, id); // idempotent re-attach

    const channelId = assignChannel(conn, id);
    const now = new Date().toISOString();
    if (!existingTab) consoleStore.createTab({ id, userId: conn.principal.userId, title: msg.title || `Terminal ${existingTabs.length + 1}`, shell: process.env.SHELL || "/bin/zsh", startCwd: msg.cwd || os.homedir(), currentCwd: msg.cwd || os.homedir(), status: "active", sortOrder: existingTabs.length, createdAt: now, lastActiveAt: now, exitedAt: null, closedAt: null });
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

    // replay scrollback to restore the screen after reconnect
    const snap = session.scrollback.snapshot();
    if (snap.byteLength > 0) setImmediate(() => conn.sendTerminal(id, new Uint8Array(snap)));

    // best-effort immediate cwd (shell may not have cd'd yet → home)
    let currentCwd = null;
    try {
      currentCwd = await readProcessCwd(session.pid);
      session.cwd = currentCwd;
    } catch {}
    return { sessionId: id, channelId, cols: session.size.cols, rows: session.size.rows, cwd: currentCwd };
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

  "term:kill": async (msg, conn) => {
    const id = msg.id || conn.focusId;
    if (!id) return null;
    const session = requireOwnedTerminal(conn, id);
    session.closed = true;
    try { session.pty.kill(); } catch {}
    consoleStore.updateTab(id, conn.principal.userId, { status: "closed", closedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() });
    detachTerminal(conn, id);
    return null;
  },

  "fs:list": async (msg, conn) => ({ entries: await fsList(msg.path, conn.principal.userId) }),
  "fs:read": async (msg, conn) => await fsRead(msg.path, msg.offset ?? 0, msg.length, conn.principal.userId),
  "fs:stat": async (msg, conn) => {
    const st = await fsp.stat(assertAllowed(msg.path, conn.principal.userId));
    return { size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() };
  },
  "fs:watch": async (msg, conn) => watchPath(conn, msg.path),
  "fs:unwatch": async (msg, conn) => { await unwatchPath(conn, msg.path); return null; },

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

const server = createServer((req, res) => handle(req, res));
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const trustedProxy=process.env.AGENT_TRUST_TUNNEL_PROXY==="1";
  const proto=trustedProxy&&req.headers["x-forwarded-proto"]?String(req.headers["x-forwarded-proto"]).split(",")[0].trim():(req.socket.encrypted?"https":"http");
  const host=trustedProxy&&(req.headers["x-forwarded-host"]||req.headers.host)?String(req.headers["x-forwarded-host"]||req.headers.host).split(",")[0].trim():req.headers.host;
  const expected = `${proto}://${host}`;
  const extra = (process.env.AGENT_WEB_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  return origin === expected || extra.includes(origin);
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") return; // leave HMR etc. to Next's own listeners
  if (!originAllowed(req)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
  const rawToken = cookieValue(req.headers.cookie, "customer_agent_session");
  const nonce = url.searchParams.get("nonce") || "";
  let principal;
  try { principal = webAuth.consumeWsNonce(rawToken || "", nonce); }
  catch (error) {
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(error?.code === "UNAUTHENTICATED" ? 4001 : 4003, "authentication failed"));
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, principal));
});

wss.on("connection", (ws, _req, principal) => {
  const conn = makeConn(ws);
  conn.principal = principal;
  connections.add(conn);
  conn.sendJson({ type: "connection:hello", userId: principal.userId, deviceId: principal.deviceId });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = Buffer.from(data);
      if (frame.byteLength < 6 || frame[0] !== 1 || frame[1] !== 1) return;
      const terminalId = conn.channelToTerminal.get(frame.readUInt32BE(2));
      if (!terminalId) return;
      const session = requireOwnedTerminal(conn, terminalId);
      if (session.inputOwner && session.inputOwner !== conn.id) return;
      session.inputOwner = conn.id;
      session.pty.write(frame.subarray(6).toString("utf8"));
      return;
    }
    handleMessage(conn, data).catch((err) => conn.sendJson({ type: "error", error: err.message }));
  });

  ws.on("close", () => {
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

server.listen(port, () => {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) urls.push(`http://${net.address}:${port}/web`);
    }
  }
  console.log(`▲ AgentRoam web gateway`);
  console.log(`   local    http://localhost:${port}/web`);
  for (const u of urls) console.log(`   network  ${u}`);
  console.log(`   auth     account login (first visit creates admin)`);
  console.log(`   roots    ${roots.join(" : ")}`);
});
