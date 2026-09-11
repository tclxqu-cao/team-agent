import { mkdir, readFile, writeFile, rename, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function lockRun(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'supervisor.lock');
  // Fail closed on stale locks: an operator must establish the old process is gone.
  const handle = await open(file, 'wx', 0o600);
  await handle.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  await handle.close();
  return () => rm(file);
}
