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
import { HostPathPolicy, SQLiteAnonymousWebStore, SQLiteProjectStore, SQLiteWebConsoleStore } from "@agent/core";
import { decodeOsc7Path, isPowerShell, selectDefaultShell } from "./shell-platform.mjs";
import {
  createPreviewTicketRegistry,
  inspectTextFile,
  inspectTextFileStatus,
  saveTextFile,
  servePreviewFile,
} from "./lib/file-preview-service.mjs";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const dir = path.dirname(fileURLToPath(import.meta.url));

const serverBaseDir = path.resolve(process.env.AGENT_DATA_DIR?.trim() || dir);
const anonymousWebStore = new SQLiteAnonymousWebStore(serverBaseDir);
const consoleStore = new SQLiteWebConsoleStore(serverBaseDir);
const projectStore = new SQLiteProjectStore(serverBaseDir);
consoleStore.markStaleTerminalsExited(new Date().toISOString());
const hostPathPolicy = HostPathPolicy.fromEnvironment(process.env.AGENT_WEB_ROOTS, os.homedir());
const roots = hostPathPolicy.roots;
const previewTickets = createPreviewTicketRegistry();

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
 *            shell:string, exited:boolean, closed:boolean, cwdWatchers:Set<(cwd:string)=>void>, inputOwner:string|null, oscTail:string}} TerminalSession
 */

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
  const powershell = isPowerShell(shell);
  const args = command ? (powershell?["-NoLogo","-Command",command]:["-l","-c",command]) : (powershell?["-NoLogo"]:["-l"]);
  const initialCwd = cwd && fsSync.existsSync(cwd) ? path.resolve(cwd) : os.homedir();
  const p = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: clampInt(cols, 2, 500, 80),
    rows: clampInt(rows, 2, 300, 24),
    cwd: initialCwd,
    env: process.env,
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
    // Tell attached clients the process is gone — otherwise the tab lives on
    // as an unresponsive zombie (no input, no output) until a page refresh.
    for (const conn of connections) {
      if (conn.attachedTo.has(id)) conn.sendJson({ type: "term:exited", id, code: exitCode });
    }
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
    // preexec remembers the command line; precmd reports it together with the
    // real exit status ($?) once the command finished — the history panel only
    // keeps successful commands. Both hooks are PREPENDED to the zsh hook
    // arrays: precmd hooks registered earlier (e.g. from the user's zshrc)
    // would run commands of their own and clobber $? before we read it.
    const hook = `function __ca_hist_preexec(){ __ca_hist_cmd="$1"; }; function __ca_hist_precmd(){ local e=$?; if [[ -n "\${__ca_hist_cmd+x}" ]]; then local c=$(printf '%s' "$__ca_hist_cmd"|base64|tr -d '\\n'); local d=$(printf '%s' "$PWD"|base64|tr -d '\\n'); printf '\\033]633;C;%s;%s;%s\\007' "$c" "$d" "$e"; unset __ca_hist_cmd; fi; }; precmd_functions=(__ca_hist_precmd $precmd_functions); preexec_functions=(__ca_hist_preexec $preexec_functions); clear`;
    setTimeout(() => {
      if (session.exited) return;
      p.write(` ${hook}\r`);
      if (queuedCommand) p.write(`${queuedCommand}\r`);
    }, 350).unref?.();
  }
  if (powershell) {
    const integration=`function global:prompt { $e=[char]27; $b=[char]7; $p=$PWD.Path -replace '\\\\','/'; $u=if($p.StartsWith('//')){'file:'+$p}else{'file:///'+$p}; Write-Host -NoNewline ($e + ']7;' + $u + $b); 'PS ' + $PWD.Path + '> ' }`;
    setTimeout(()=>{if(!session.exited){p.write(`${integration}\r`);if(queuedCommand)p.write(`${queuedCommand}\r`);}},350).unref?.();
  }
  if (!shell.endsWith("zsh") && !powershell && queuedCommand) {
    setTimeout(() => { if (!session.exited) p.write(`${queuedCommand}\r`); }, 350).unref?.();
  }
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
  json: "application/json", txt: "text/plain; charset=utf-8",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
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
    sendTerminalReset(terminalId) {
      if (ws.readyState !== ws.OPEN) return;
      const channelId = assignChannel(this, terminalId);
      const frame = Buffer.allocUnsafe(6);
      frame[0] = 1; frame[1] = 3; frame.writeUInt32BE(channelId, 2);
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

    // Replay scrollback to restore the screen after reconnect. Reset the client
    // pane first: a reconnecting client still holds the old buffer, and
    // appending the replay onto it duplicates all the content.
    conn.sendTerminalReset(id);
    const snap = session.scrollback.snapshot();
    if (snap.byteLength > 0) setImmediate(() => conn.sendTerminal(id, new Uint8Array(snap)));

    // best-effort immediate cwd (shell may not have cd'd yet → home)
    let currentCwd = session.cwd;
    try {
      const detectedCwd = await readProcessCwd(session.pid);
      if (detectedCwd) currentCwd = session.cwd = detectedCwd;
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

  "ping": async () => ({ pong: true, t: Date.now() }),

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

const server = createServer((req, res) => {
  void serveTicketedFilePreview(req, res)
    .then((handled) => handled || serveWebApp(req, res))
    .then((handled) => { if (!handled) handle(req, res); })
    .catch((error) => {
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
      else res.destroy(error);
    });
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

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
  const nonce = url.searchParams.get("nonce") || "";
  const userId = anonymousWebStore.consumeWsNonce(nonce);
  if (!userId) {
    wss.handleUpgrade(req, socket, head, (ws) => ws.close(4003, "invalid nonce"));
    return;
  }
  const principal = { userId, username: "local", deviceId: "browser" };
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
      // Input frames race the terminal's own close (in-flight keystrokes while
      // the tab tears down) — drop them silently instead of throwing.
      const session = terminals.get(terminalId);
      if (!session || session.exited || session.userId !== conn.principal?.userId) return;
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
  console.log(`   auth     passwordless local console`);
  console.log(`   roots    ${roots.join(" : ")}`);
});
