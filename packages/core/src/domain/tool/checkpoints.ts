import { dirname } from "node:path";
import { promises as fsp } from "node:fs";
import type { IToolExecutor, ToolContext, ToolResult } from "./entities.js";
import { writePaths } from "./permissions.js";

/** Tools whose execution mutates workspace files and therefore is checkpointed. */
const CHECKPOINTED_TOOLS = new Set(["write_file", "str_replace", "apply_patch"]);

const MAX_FILE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 20 * 1024 * 1024;
const MAX_BATCHES = 10;

/** Pre-image of a single workspace file. */
export interface FileSnapshot {
  path: string;
  /** false = the file did not exist before the tool ran (undo removes it). */
  existed: boolean;
  /** null when existed is false. */
  content: string | null;
}

export interface CheckpointBatch {
  snapshots: FileSnapshot[];
}

/** Storage boundary for checkpoint batches (DDD: executor depends on this interface). */
export interface IFileCheckpointJournal {
  /** Start a new undo batch; subsequent snapshots land in it. */
  beginBatch(): void;
  /** Snapshot a file's pre-image into the current batch (best effort). */
  snapshot(path: string): Promise<void>;
  /** Restore and drop the most recent batch; returns restored paths, or null when empty. */
  undoLastBatch(): Promise<string[] | null>;
  /** Number of undoable batches. */
  batchCount(): number;
}

/** In-memory undo journal with bounded snapshot size. */
export class InMemoryFileCheckpointJournal implements IFileCheckpointJournal {
  private readonly batches: CheckpointBatch[] = [];
  private totalBytes = 0;

  beginBatch(): void {
    this.batches.push({ snapshots: [] });
    while (this.batches.length > MAX_BATCHES) {
      this.dropOldest();
    }
  }

  async snapshot(path: string): Promise<void> {
    const batch = this.batches.at(-1);
    if (!batch) return;
    if (batch.snapshots.some((snapshot) => snapshot.path === path)) return;
    try {
      const content = await fsp.readFile(path, "utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_SNAPSHOT_BYTES) return;
      this.push(batch, { path, existed: true, content });
    } catch {
      // Missing file: record non-existence so undo removes files the tool created.
      this.push(batch, { path, existed: false, content: null });
    }
  }

  async undoLastBatch(): Promise<string[] | null> {
    const batch = this.batches.pop();
    if (!batch) return null;
    const restored: string[] = [];
    // Reverse order so multi-step patches unwind correctly.
    for (const snapshot of [...batch.snapshots].reverse()) {
      try {
        if (snapshot.existed && snapshot.content !== null) {
          await fsp.mkdir(dirname(snapshot.path), { recursive: true });
          await fsp.writeFile(snapshot.path, snapshot.content, "utf8");
        } else {
          await fsp.rm(snapshot.path, { force: true });
        }
        restored.push(snapshot.path);
      } catch {
        // Best-effort restore; skip unreadable/undeletable paths.
      }
    }
    return restored;
  }

  batchCount(): number {
    return this.batches.length;
  }

  private push(batch: CheckpointBatch, snapshot: FileSnapshot): void {
    batch.snapshots.push(snapshot);
    this.totalBytes += snapshot.content ? Buffer.byteLength(snapshot.content, "utf8") : 0;
    while (this.totalBytes > MAX_JOURNAL_BYTES && this.batches.length > 1) {
      this.dropOldest();
    }
  }

  private dropOldest(): void {
    const oldest = this.batches.shift();
    if (!oldest) return;
    for (const snapshot of oldest.snapshots) {
      this.totalBytes -= snapshot.content ? Buffer.byteLength(snapshot.content, "utf8") : 0;
    }
  }
}

/**
 * Decorator that snapshots workspace files before write tools run, enabling
 * turn-scoped undo. Composes like PermissionAwareToolExecutor: it wraps any
 * IToolExecutor and forwards everything it does not intercept.
 */
export class CheckpointAwareToolExecutor implements IToolExecutor {
  constructor(
    private readonly delegate: IToolExecutor,
    private readonly journal: IFileCheckpointJournal,
  ) {}

  validate(name: string, args: Record<string, unknown>): boolean {
    return this.delegate.validate(name, args);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!CHECKPOINTED_TOOLS.has(name)) {
      return this.delegate.execute(name, args, ctx);
    }
    const paths = writePaths(name, args);
    for (const path of paths) {
      await this.journal.snapshot(path);
    }
    return this.delegate.execute(name, args, ctx);
  }
}
