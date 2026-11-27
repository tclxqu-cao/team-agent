import { execFile } from "node:child_process";
import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export interface QoderActivityReader {
  readMany(sessions: readonly { id: string }[]): Promise<ReadonlyMap<string, boolean>>;
}

interface Turn { id: string; startedAt: number; timestamp: number; running: boolean }
interface LogCursor {
  identity: string;
  offset: number;
  pending: Buffer;
  overflow: boolean;
  turns: Map<string, Turn>;
}
interface Options {
  home?: string;
  processStarts?: (pids: readonly number[]) => Promise<ReadonlyMap<number, number>>;
}

const execFileAsync = promisify(execFile);
const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 128 * 1024;

async function qoderProcessStarts(pids: readonly number[]): Promise<ReadonlyMap<number, number>> {
  if (!pids.length) return new Map();
  const { stdout } = await execFileAsync("ps", ["-p", pids.join(","), "-o", "pid=,lstart=,comm="], { encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
  const result = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (!match || !/(?:^|\/)(?:Qoder|qodercli(?:-[\d.]+)?)$/.test(match[3])) continue;
    const startedAt = Date.parse(match[2]);
    if (Number.isFinite(startedAt)) result.set(Number(match[1]), startedAt);
  }
  return result;
}

/** ACP lists persisted sessions but omits external turn state. Native main-turn
 * boundaries and their process identity supply activity without resuming a writer. */
export class QoderDesktopActivityReader implements QoderActivityReader {
  private readonly root: string;
  private readonly processStarts: NonNullable<Options["processStarts"]>;
  private readonly cursors = new Map<string, LogCursor>();
  private pending: Promise<void> | undefined;

  constructor(options: Options = {}) {
    this.root = join(options.home ?? homedir(), ".qoder/logs/runs");
    this.processStarts = options.processStarts ?? qoderProcessStarts;
  }

  async readMany(sessions: readonly { id: string }[]): Promise<ReadonlyMap<string, boolean>> {
    if (!sessions.length) return new Map();
    try {
      const refresh = this.pending ??= this.refresh();
      try { await refresh; }
      finally { if (this.pending === refresh) this.pending = undefined; }
      const latest = new Map<string, Turn>();
      for (const cursor of this.cursors.values()) {
        for (const [id, turn] of cursor.turns) {
          const previous = latest.get(id);
          if (!previous || turn.startedAt > previous.startedAt
            || (turn.startedAt === previous.startedAt && turn.timestamp > previous.timestamp)) latest.set(id, turn);
        }
      }
      return new Map(sessions.flatMap(({ id }) => latest.has(id) ? [[id, latest.get(id)!.running] as const] : []));
    } catch {
      this.cursors.clear();
      return new Map();
    }
  }

  private async refresh(): Promise<void> {
    const directories = await readdir(this.root, { withFileTypes: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const pids = [...new Set(directories.filter(directory => directory.isDirectory())
      .flatMap(directory => { const match = /-p(\d+)$/.exec(directory.name); return match ? [Number(match[1])] : []; }))];
    const processes = await this.processStarts(pids);
    const paths = new Set<string>();
    for (const directory of directories) {
      const pid = Number(/-p(\d+)$/.exec(directory.name)?.[1]);
      if (!directory.isDirectory() || !processes.has(pid)) continue;
      const root = join(this.root, directory.name);
      try {
        const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as { pid?: unknown; started_at?: unknown };
        const startedAt = typeof manifest.started_at === "string" ? Date.parse(manifest.started_at) : NaN;
        // A recycled PID must not revive an old, unfinished turn.
        if (manifest.pid !== pid || !Number.isFinite(startedAt) || Math.abs(startedAt - processes.get(pid)!) > 30_000) continue;
        const path = join(root, "qodercli.log");
        await this.read(path);
        paths.add(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const path of this.cursors.keys()) if (!paths.has(path)) this.cursors.delete(path);
  }

  private async read(path: string): Promise<void> {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      const identity = `${info.dev}:${info.ino}`;
      const previous = this.cursors.get(path);
      const cursor: LogCursor = previous && previous.identity === identity && previous.offset <= info.size
        ? previous : { identity, offset: 0, pending: Buffer.alloc(0), overflow: false, turns: new Map() };
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      while (cursor.offset < info.size) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, info.size - cursor.offset), cursor.offset);
        if (!bytesRead) throw new Error("Qoder log truncated during discovery");
        cursor.offset += bytesRead;
        this.consume(chunk.subarray(0, bytesRead), cursor);
      }
      this.cursors.set(path, cursor);
    } finally { await file.close(); }
  }

  private consume(chunk: Buffer, cursor: LogCursor): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, newline < 0 ? chunk.length : newline);
      if (!cursor.overflow && cursor.pending.length + part.length <= MAX_LINE_BYTES) cursor.pending = Buffer.concat([cursor.pending, part]);
      else { cursor.pending = Buffer.alloc(0); cursor.overflow = true; }
      if (newline < 0) return;
      if (!cursor.overflow) this.line(cursor.pending.toString("utf8"), cursor.turns);
      cursor.pending = Buffer.alloc(0); cursor.overflow = false;
      offset = newline + 1;
    }
  }

  private line(line: string, turns: Map<string, Turn>): void {
    const match = /^(\S+)\s+\w+\s+\[session=([\w-]+) turn=([^\s\]]+)[^\]]*\]\s+turn\.(started|finished)(?:\s|$)(.*)$/.exec(line);
    if (!match) return;
    const [, date, sessionId, turnId, event, attributes] = match;
    const timestamp = Date.parse(date);
    const previous = turns.get(sessionId);
    if (!Number.isFinite(timestamp) || (previous && timestamp < previous.timestamp)) return;
    if (event === "started") {
      if (!/\bis_subagent=false(?:\s|$)/.test(attributes)) return;
      turns.set(sessionId, { id: turnId, startedAt: timestamp, timestamp, running: true });
    } else if (previous?.id === turnId) {
      turns.set(sessionId, { ...previous, timestamp, running: false });
    }
  }
}
