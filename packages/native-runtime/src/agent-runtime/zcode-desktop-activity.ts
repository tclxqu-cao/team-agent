import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeAgentWorkspacePath } from "./agent-workspace-index.js";

export interface ZCodeActivitySession { id: string; cwd: string }
export interface ZCodeActivityReader {
  readMany(sessions: readonly ZCodeActivitySession[]): Promise<ReadonlyMap<string, boolean>>;
}

interface Turn { id: string; timestamp: number; running: boolean }
interface Owner { pid: number; timestamp: number }
interface Cursor {
  identity: string;
  offset: number;
  modified: number;
  pending: Buffer;
  overflow: boolean;
}
interface LogFile { path: string; kind: "cli" | "desktop"; identity: string; size: number; modified: number }
interface Options { home?: string; isProcessAlive?: (pid: number) => boolean }

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 128 * 1024;
const PROCESS_STARTED = "ZCode agent process started ";
const TURN_EVENTS = new Set(["turn.started", "turn.completed", "turn.failed"]);

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Legacy session/list omits live projections. Read native turn boundaries and
 * their desktop workspace owner without materializing or sending to a session. */
export class ZCodeDesktopActivityReader implements ZCodeActivityReader {
  private readonly root: string;
  private readonly alive: (pid: number) => boolean;
  private readonly cursors = new Map<string, Cursor>();
  private readonly turns = new Map<string, Turn>();
  private readonly owners = new Map<string, Map<number, Owner>>();
  private pending: Promise<void> | undefined;

  constructor(options: Options = {}) {
    this.root = join(options.home ?? homedir(), ".zcode");
    this.alive = options.isProcessAlive ?? processAlive;
  }

  async readMany(sessions: readonly ZCodeActivitySession[]): Promise<ReadonlyMap<string, boolean>> {
    if (!sessions.length) return new Map();
    try {
      const refresh = this.pending ??= this.refresh();
      try { await refresh; }
      finally { if (this.pending === refresh) this.pending = undefined; }
      const processes = new Map<number, boolean>();
      const result = new Map<string, boolean>();
      for (const session of sessions) {
        const turn = this.turns.get(session.id);
        if (!turn) continue;
        if (!turn.running) { result.set(session.id, false); continue; }
        const owners = this.owners.get(normalizeAgentWorkspacePath(session.cwd));
        if (!owners?.size) continue;
        // A replacement workspace process cannot own a turn started by its predecessor.
        result.set(session.id, [...owners.values()].some(owner => {
          if (owner.timestamp > turn.timestamp) return false;
          if (!processes.has(owner.pid)) processes.set(owner.pid, this.alive(owner.pid));
          return processes.get(owner.pid) === true;
        }));
      }
      return result;
    } catch {
      this.reset();
      return new Map();
    }
  }

  private reset(): void { this.cursors.clear(); this.turns.clear(); this.owners.clear(); }

  private async files(directory: string, kind: LogFile["kind"], pattern: RegExp): Promise<LogFile[]> {
    let names: string[];
    try { names = (await readdir(directory)).filter(name => pattern.test(name)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const files = await Promise.all(names.map(async name => {
      const path = join(directory, name);
      const info = await stat(path);
      return info.isFile() ? { path, kind, identity: `${info.dev}:${info.ino}`, size: info.size, modified: info.mtimeMs } : null;
    }));
    return files.filter((file): file is LogFile => file !== null);
  }

  private async refresh(): Promise<void> {
    const groups = await Promise.all([
      this.files(join(this.root, "cli/log"), "cli", /^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/),
      this.files(join(this.root, "v2/logs"), "desktop", /^\d{4}-\d{2}-\d{2}\.log$/),
    ]);
    const files = groups.flat();
    const paths = new Set(files.map(file => file.path));
    if ([...this.cursors.keys()].some(path => !paths.has(path)) || files.some(file => {
      const cursor = this.cursors.get(file.path);
      return cursor && (cursor.identity !== file.identity || cursor.offset > file.size
        || (cursor.offset === file.size && cursor.modified !== file.modified));
    })) this.reset();
    for (const file of files) await this.read(file);
  }

  private async read(file: LogFile): Promise<void> {
    const previous = this.cursors.get(file.path);
    if (previous?.offset === file.size) return;
    const handle = await open(file.path, "r");
    try {
      const info = await handle.stat();
      if (`${info.dev}:${info.ino}` !== file.identity || info.size < (previous?.offset ?? 0)) {
        throw new Error("ZCode log changed during discovery");
      }
      const cursor: Cursor = previous ?? { identity: file.identity, offset: 0, modified: 0, pending: Buffer.alloc(0), overflow: false };
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      while (cursor.offset < info.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, info.size - cursor.offset), cursor.offset);
        if (!bytesRead) throw new Error("ZCode log truncated during discovery");
        cursor.offset += bytesRead;
        this.consume(chunk.subarray(0, bytesRead), cursor, file.kind);
      }
      cursor.modified = info.mtimeMs;
      this.cursors.set(file.path, cursor);
    } finally { await handle.close(); }
  }

  private consume(chunk: Buffer, cursor: Cursor, kind: LogFile["kind"]): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, newline < 0 ? chunk.length : newline);
      if (!cursor.overflow && cursor.pending.length + part.length <= MAX_LINE_BYTES) {
        cursor.pending = Buffer.concat([cursor.pending, part]);
      } else { cursor.pending = Buffer.alloc(0); cursor.overflow = true; }
      if (newline < 0) return;
      if (!cursor.overflow) this.line(cursor.pending.toString("utf8"), kind);
      cursor.pending = Buffer.alloc(0); cursor.overflow = false;
      offset = newline + 1;
    }
  }

  private line(line: string, kind: LogFile["kind"]): void {
    try {
      if (kind === "desktop") {
        const index = line.indexOf(PROCESS_STARTED);
        if (index < 0) return;
        const record = JSON.parse(line.slice(index + PROCESS_STARTED.length)) as { cwd?: unknown; pid?: unknown };
        const time = /^\[([^\]]+)\]/.exec(line)?.[1];
        const timestamp = time ? Date.parse(time.replace(" ", "T")) : NaN;
        if (typeof record.cwd !== "string" || typeof record.pid !== "number" || !Number.isSafeInteger(record.pid)
          || record.pid <= 0 || !Number.isFinite(timestamp)) return;
        const cwd = normalizeAgentWorkspacePath(record.cwd);
        const owners = this.owners.get(cwd) ?? new Map<number, Owner>();
        const previous = owners.get(record.pid);
        if (!previous || timestamp >= previous.timestamp) owners.set(record.pid, { pid: record.pid, timestamp });
        this.owners.set(cwd, owners);
        return;
      }
      if (!line.includes('"turn.started"') && !line.includes('"turn.completed"') && !line.includes('"turn.failed"')) return;
      const record = JSON.parse(line) as { event?: unknown; sessionId?: unknown; turnId?: unknown; timestamp?: unknown };
      if (typeof record.event !== "string" || !TURN_EVENTS.has(record.event) || typeof record.sessionId !== "string"
        || typeof record.turnId !== "string" || typeof record.timestamp !== "string") return;
      const timestamp = Date.parse(record.timestamp);
      if (!Number.isFinite(timestamp)) return;
      const previous = this.turns.get(record.sessionId);
      if (previous && timestamp < previous.timestamp) return;
      // A late terminal event for a preceding turn must not clear the current turn.
      if (record.event !== "turn.started" && previous && previous.id !== record.turnId) return;
      this.turns.set(record.sessionId, { id: record.turnId, timestamp, running: record.event === "turn.started" });
    } catch { /* Incomplete or unrelated native log records do not change lifecycle state. */ }
  }
}
