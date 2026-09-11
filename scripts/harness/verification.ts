import { access, mkdir, mkdtemp, writeFile, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runCommand, type CommandResult } from './process.js';

/** No model credentials/network, no source writes, no writes outside the disposable test scratch. */
export async function sandboxCommand(command: string[], root: string, scratch: string,
  env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  if (process.platform !== 'darwin') throw new Error('Harness candidate verification currently requires macOS sandbox-exec');
  await access('/usr/bin/sandbox-exec');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const writable = await mkdtemp(join(scratch, 'sandbox-'));
  const profile = join(scratch, 'verify.sb');
  const resolvedPaths = new Map<string, string>();
  for (const p of [root, scratch, writable, env.HARNESS_STABLE_ROOT!, env.HARNESS_DEPENDENCIES!, env.HARNESS_BUN_DIRECTORY!, env.HARNESS_NODE_DIRECTORY!]) {
    resolvedPaths.set(p, await realpath(p));
  }
  const literal = (value: string) => JSON.stringify(resolvedPaths.get(value) ?? resolve(value));
  await writeFile(profile, `(version 1)
(allow default)
(deny network*)
(deny signal)
(allow signal (target same-sandbox))
(deny file-read-data)
(deny file-write*)
(allow file-read-data (vnode-type DIRECTORY))
(allow file-read-data (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin")
 (subpath "/Library") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/dev")
 (subpath ${literal(root)}) (subpath ${literal(env.HARNESS_STABLE_ROOT!)})
 (subpath ${literal(env.HARNESS_DEPENDENCIES!)})
 (subpath ${literal(env.HARNESS_BUN_DIRECTORY!)}) (subpath ${literal(env.HARNESS_NODE_DIRECTORY!)}) (subpath ${literal(scratch)}))
(allow file-write* (subpath ${literal(writable)}) (literal "/dev/null"))
`, { mode: 0o600 });
  return runCommand(['/usr/bin/sandbox-exec', '-f', profile, ...command], {
    cwd: root, timeoutMs, signal,
    env: { PATH: process.env.PATH, TMPDIR: writable, HOME: writable, CI: '1', ...env },
  });
}

/** Digest the evaluated tree, excluding the dependency link and Git metadata. */
export async function sourceDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (dir: string) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const file = join(dir, entry.name);
      hash.update(file.slice(root.length));
      if (entry.isDirectory()) await walk(file);
      else if (entry.isSymbolicLink()) throw new Error('Unexpected candidate symlink');
      else hash.update(await readFile(file));
    }
  };
  await walk(root);
  return hash.digest('hex');
}
