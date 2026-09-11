import { lstat, readFile, writeFile, mkdir, symlink, realpath, rm } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand } from './process.js';

export interface SourceEdit { path: string; before: string; after: string }
export interface RepairProposal { reason: string; edits: SourceEdit[]; reproduction: string }
const protectedPath = /(?:^|\/)(?:__tests__|node_modules|\.git)(?:\/|$)|\.(?:test|spec)\.|run-checkpoint|RunCheckpointStore|\/permissions\.ts$/;

export function validateEditablePath(file: string): void {
  if (!file.startsWith('packages/core/src/') || !file.endsWith('.ts') ||
      file.includes('\\') || file.split('/').some(part => part === '..' || part === '.') ||
      protectedPath.test(file)) throw new Error(`Protected or invalid repair path: ${file}`);
}

async function git(repo: string, args: string[], env = process.env): Promise<string> {
  const result = await runCommand(['git', ...args], { cwd: repo, env, timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.output}`);
  return result.output.trim();
}

/** Snapshot tracked dirty files with a temporary index; never change the user's index or branch. */
export async function snapshotSource(repo: string, destination: string): Promise<string> {
  repo = await realpath(repo);
  if (await git(repo, ['rev-parse', '--show-toplevel']) !== repo) throw new Error('sourceRoot must be the repository root');
  const index = join(dirname(destination), `index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await git(repo, ['read-tree', '--empty'], env);
    // Include new source modules used by the current dirty Harness, not output/runtime files.
    await git(repo, ['add', '--', 'packages/core/src', 'packages/core/package.json', 'packages/core/tsconfig.json',
      'package.json', 'tsconfig.json', 'vitest.config.ts', '.gitignore', 'scripts/harness'], env);
    const tree = await git(repo, ['write-tree'], env);
    const commit = await git(repo, ['-c', 'user.name=Harness Snapshot', '-c', 'user.email=harness@localhost',
      'commit-tree', tree, '-p', 'HEAD', '-m', 'Local Harness snapshot (no branch change)'], env);
    await git(repo, ['worktree', 'add', '--detach', destination, commit]);
    return commit;
  } finally { await rm(index, { force: true }); }
}

export async function forkVersion(repo: string, base: string, destination: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--detach', destination, base]);
}

/** Dependencies stay read-only during verification; no candidate-controlled install scripts. */
export async function linkDependencies(source: string, candidate: string): Promise<void> {
  for (const folder of ['node_modules', 'packages/core/node_modules']) {
    const original = join(source, folder);
    try { await lstat(original); } catch { continue; }
    await mkdir(dirname(join(candidate, folder)), { recursive: true });
    await symlink(await realpath(original), join(candidate, folder), 'dir');
  }
}

export async function applyProposal(root: string, allowed: string[], proposal: RepairProposal): Promise<void> {
  if (typeof proposal.reason !== 'string' || !proposal.reason.trim() ||
      !Array.isArray(proposal.edits) || proposal.edits.length < 1 || proposal.edits.length > 8 ||
      typeof proposal.reproduction !== 'string' || !proposal.reproduction.trim() || proposal.reproduction.length > 40_000) {
    throw new Error('Invalid repair proposal');
  }
  const contents = new Map<string, string>();
  for (const edit of proposal.edits) {
    validateEditablePath(edit.path);
    if (!allowed.includes(edit.path)) throw new Error(`Repair path not allowed: ${edit.path}`);
    const file = resolve(root, edit.path);
    const actual = await realpath(file);
    const rel = relative(await realpath(root), actual);
    if (rel.startsWith('..') || isAbsolute(rel) || (await lstat(file)).isSymbolicLink()) throw new Error('Repair symlink escape');
    let content = contents.get(file) ?? await readFile(file, 'utf8');
    if (typeof edit.before !== 'string' || !edit.before || typeof edit.after !== 'string' ||
        edit.after.length > 100_000 || edit.before === edit.after ||
        content.split(edit.before).length !== 2) throw new Error(`Repair must match exactly once: ${edit.path}`);
    content = content.replace(edit.before, () => edit.after);
    contents.set(file, content);
  }
  for (const [file, content] of contents) await writeFile(file, content);
}

export async function sealVersion(root: string, allowed: string[]): Promise<string> {
  await git(root, ['add', '--', ...allowed]);
  const tree = await git(root, ['write-tree']);
  const commit = await git(root, ['-c', 'user.name=Harness Repair', '-c', 'user.email=harness@localhost',
    'commit-tree', tree, '-p', 'HEAD', '-m', 'Verified local Harness candidate']);
  // Detached worktree only. No branch, user index or remote is touched.
  await git(root, ['reset', '--soft', commit]);
  return commit;
}
