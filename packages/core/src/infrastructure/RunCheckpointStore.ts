import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateRunCheckpoint, type IRunCheckpointStore, type RunCheckpoint } from '../domain/agent/run-checkpoint.js';

/** Atomic replacement: a process crash leaves either the old or the new checkpoint. */
export class FileRunCheckpointStore implements IRunCheckpointStore {
  constructor(private readonly file: string) {}

  async load(): Promise<RunCheckpoint | null> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const checkpoint: unknown = JSON.parse(text);
    validateRunCheckpoint(checkpoint);
    return checkpoint;
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    validateRunCheckpoint(checkpoint);
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(checkpoint)); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, this.file);
    } finally { await rm(temp, { force: true }); }
  }
}
