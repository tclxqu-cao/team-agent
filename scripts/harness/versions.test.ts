import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './process.js';
import { applyProposal, snapshotSource, validateEditablePath } from './versions.js';
import { lockRun } from './state.js';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-version-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(join(source, 'packages/core/src'), { recursive: true });
  await mkdir(join(source, 'scripts/harness'), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json', 'vitest.config.ts', '.gitignore', 'packages/core/package.json', 'packages/core/tsconfig.json', 'scripts/harness/entry.ts']) {
    await writeFile(join(source, file), '');
  }
  await writeFile(join(source, 'packages/core/src/bug.ts'), 'export const x = 1;');
  const git = async (...args: string[]) => {
    const result = await runCommand(['git', ...args], { cwd: source, timeoutMs: 5000 });
    if (result.code !== 0) throw new Error(result.output); return result.output;
  };
  await git('init'); await git('add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'initial');
  return { root, source, git };
}
afterEach(async () => { for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('Harness candidate source isolation', () => {
  it('snapshots current source without changing the real index or copying unrelated secrets', async () => {
    const { root, source, git } = await fixture();
    await writeFile(join(source, 'packages/core/src/bug.ts'), 'export const x = 2;');
    await writeFile(join(source, 'secret.env'), 'private');
    const before = await git('diff', '--cached');
    const candidate = join(root, 'candidate');
    await snapshotSource(source, candidate);
    expect(await readFile(join(candidate, 'packages/core/src/bug.ts'), 'utf8')).toContain('= 2');
    expect(await git('diff', '--cached')).toBe(before);
    await expect(readFile(join(candidate, 'secret.env'))).rejects.toThrow();
    expect(await git('diff')).toContain('= 2');
  });
  it('enforces exact path and substring scope and rejects symlinks', async () => {
    const { root, source } = await fixture();
    const file = 'packages/core/src/bug.ts';
    const proposal = { reason: 'fix', edits: [{ path: file, before: '= 1', after: '= 2' }], reproduction: 'assert' };
    await applyProposal(source, [file], proposal);
    expect(await readFile(join(source, file), 'utf8')).toContain('= 2');
    await expect(applyProposal(source, [file], proposal)).rejects.toThrow('exactly once');
    for (const path of ['scripts/harness/run.ts', 'packages/core/src/../escape.ts', 'packages/core/src/foo.test.ts',
      'packages/core/src/domain/tool/permissions.ts', 'packages/core/src/domain/agent/run-checkpoint.ts']) {
      expect(() => validateEditablePath(path)).toThrow();
    }
    await writeFile(join(root, 'outside.ts'), '= 1');
    await symlink(join(root, 'outside.ts'), join(source, 'packages/core/src/link.ts'));
    await expect(applyProposal(source, ['packages/core/src/link.ts'], { ...proposal,
      edits: [{ path: 'packages/core/src/link.ts', before: '= 1', after: '= 2' }] })).rejects.toThrow('symlink');
  });
  it('allows only one owner of the task/version state', async () => {
    const { root } = await fixture();
    const release = await lockRun(root);
    await expect(lockRun(root)).rejects.toThrow();
    await release();
    await (await lockRun(root))();
  });
});
