import { createServer } from 'node:http';
import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { sandboxCommand } from './verification.js';

it.skipIf(process.platform !== 'darwin')('verification sandbox denies source writes, unrelated file reads and network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-sandbox-test-'));
  const secret = `${root}-outside.txt`;
  const scratch = join(root, 'scratch');
  const file = join(root, 'source.txt');
  const server = createServer((_req, res) => res.end('reachable'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port:number}).port;
  try {
    await writeFile(file, 'original'); await writeFile(secret, 'private');
    const bun = join(homedir(), '.bun/bin/bun');
    const node = join(homedir(), '.nvm/versions/node/v22.22.0/bin/node');
    const program = `const fs=require('node:fs'); const assert=require('node:assert/strict');
      assert.throws(()=>fs.writeFileSync(${JSON.stringify(file)}, 'changed'));
      assert.throws(()=>fs.readFileSync(${JSON.stringify(secret)}));
      fetch('http://127.0.0.1:${port}').then(()=>process.exit(3),()=>console.log('isolated'));`;
    const result = await sandboxCommand([node, '-e', program], root, scratch, {
      HARNESS_STABLE_ROOT: root, HARNESS_DEPENDENCIES: await realpath('node_modules'),
      HARNESS_BUN_DIRECTORY: dirname(bun), HARNESS_NODE_DIRECTORY: dirname(node),
    }, 10_000);
    expect(result, result.output).toMatchObject({ code: 0 });
    expect(result.output).toContain('isolated');
    expect(await readFile(file, 'utf8')).toBe('original');
  } finally { await new Promise<void>(resolve => server.close(()=>resolve())); await rm(root, { recursive: true, force: true }); await rm(secret, { force: true }); }
});
