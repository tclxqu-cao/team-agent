import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WindowsRemoteHelperApp, WINDOWS_HELPER_EXECUTABLE as exe, WINDOWS_HELPER_METADATA as metadata, windowsHelperInstallDirectory } from '../packages/server/lib/remote-control/windows-helper-app.mjs';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function payload(directory, version, marker = version) {
  await mkdir(directory, { recursive: true });
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 0x3c); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68); pe.write(marker, 80);
  const contents = { [exe]: pe, 'remote-helper-NOTICES.txt': Buffer.from('third party notices') };
  const files = {};
  for (const [name, bytes] of Object.entries(contents)) { await writeFile(join(directory, name), bytes); files[name] = createHash('sha256').update(bytes).digest('hex'); }
  await writeFile(join(directory, metadata), JSON.stringify({ component: 'agentroam-remote-desktop', version, files }));
}

async function fixture(version = '0.2.0-preview.57') {
  const root = await mkdtemp(join(tmpdir(), 'agentroam-windows-install-')); roots.push(root);
  const source = join(root, 'new/runtime/native'), installDir = join(root, 'Local AppData/AgentRoam/RemoteDesktop');
  await payload(source, version);
  const running = [], stopped = [];
  let queue = Promise.resolve();
  const options = { sourcePath: join(source, exe), installDir, processes: async () => [...running], stopProcesses: async items => {
    stopped.push(...items); for (const item of items) { const i = running.findIndex(p => p.pid === item.pid); if (i >= 0) running.splice(i, 1); }
  }, acquireLock: async () => {
    const previous = queue; let release;
    queue = new Promise(resolve => { release = resolve; }); await previous; return release;
  } };
  return { root, source, installDir, running, stopped, options, app: new WindowsRemoteHelperApp(options) };
}

test('uses LOCALAPPDATA with a profile fallback and rejects a relative override', () => {
  assert.equal(windowsHelperInstallDirectory({ localAppData: 'D:\\Profiles\\张三\\AppData\\Local' }), 'D:\\Profiles\\张三\\AppData\\Local\\AgentRoam\\RemoteDesktop');
  assert.equal(windowsHelperInstallDirectory({ localAppData: '', home: 'C:\\Users\\test' }), 'C:\\Users\\test\\AppData\\Local\\AgentRoam\\RemoteDesktop');
  assert.throws(() => windowsHelperInstallDirectory({ localAppData: 'relative' }), /绝对路径/);
});

test('creates the fixed directory and preserves the same installed bytes on repeated starts', async () => {
  const f = await fixture(); assert.equal((await f.app.describe()).installed, false);
  const path = await f.app.prepare(); assert.equal(path, join(f.installDir, exe));
  const before = await stat(path); await f.app.prepare(); const after = await stat(path);
  assert.equal(before.ino, after.ino); assert.equal(before.mtimeMs, after.mtimeMs);
  assert.deepEqual((await f.app.describe()).version, '0.2.0-preview.57');
  assert.deepEqual(await readdir(dirname(f.installDir)), ['RemoteDesktop']);
});

test('stops the active old component, replaces it immediately and removes its backup', async () => {
  const f = await fixture(); await payload(f.installDir, '0.2.0-preview.56');
  const process = { pid: 17, path: join(f.installDir, exe) }; f.running.push(process);
  await f.app.prepare(); assert.deepEqual(f.stopped, [process]);
  assert.equal((await f.app.describe()).version, '0.2.0-preview.57');
  assert.equal((await f.app.describe()).updatePending, false);
  assert.deepEqual(await readdir(dirname(f.installDir)), ['RemoteDesktop']);
});

test('keeps a newer installed version when an older CLI starts, without stopping it', async () => {
  const f = await fixture(); await payload(f.installDir, '0.2.0-preview.58');
  f.running.push({ pid: 17, path: join(f.installDir, exe) });
  await f.app.prepare(); assert.equal((await f.app.describe()).version, '0.2.0-preview.58'); assert.equal(f.stopped.length, 0);
});

test('retires an identified old npm helper while preserving its CLI, unlock service and user files', async () => {
  const f = await fixture(); const directory = join(f.root, 'old/runtime/native'); await payload(directory, '0.2.0-preview.55');
  await writeFile(join(directory, '../../package.json'), JSON.stringify({ name: 'agentroam-runtime-win32-x64', version: '0.2.0-preview.55' }));
  await writeFile(join(directory, 'agentroam-remote-unlock.exe'), 'unlock service');
  await writeFile(join(directory, '../../sessions.json'), 'keep sessions');
  f.running.push({ pid: 19, path: join(directory, exe) }, { pid: 20, path: join(directory, exe) });
  await f.app.prepare(); assert.equal(f.stopped.length, 2);
  await assert.rejects(readFile(join(directory, exe)), { code: 'ENOENT' });
  assert.equal(await readFile(join(directory, 'agentroam-remote-unlock.exe'), 'utf8'), 'unlock service');
  assert.equal(await readFile(join(directory, '../../sessions.json'), 'utf8'), 'keep sessions');
  assert.equal((await f.app.describe()).installed, true);
});

test('does not kill a process whose executable is outside a recognized AgentRoam installation', async () => {
  const f = await fixture(); const directory = join(f.root, 'unrelated'); await payload(directory, '0.2.0-preview.55');
  f.running.push({ pid: 19, path: join(directory, exe) });
  await assert.rejects(f.app.prepare(), /无法确认旧远控组件归属/); assert.equal(f.stopped.length, 0);
  assert.equal((await f.app.describe()).installed, false);
});

test('keeps the old installation if stopping it fails', async () => {
  const f = await fixture(); await payload(f.installDir, '0.2.0-preview.56');
  f.running.push({ pid: 17, path: join(f.installDir, exe) });
  const app = new WindowsRemoteHelperApp({ ...f.options, stopProcesses: async () => { throw new Error('stop denied'); } });
  await assert.rejects(app.prepare(), /stop denied/); assert.equal((await app.describe()).version, '0.2.0-preview.56');
  assert.deepEqual(await readdir(dirname(f.installDir)), ['RemoteDesktop']);
});

test('validates a replacement before stopping the old helper', async () => {
  const f = await fixture(); await payload(f.installDir, '0.2.0-preview.56');
  f.running.push({ pid: 17, path: join(f.installDir, exe) }); await writeFile(join(f.source, exe), 'broken');
  await assert.rejects(f.app.prepare(), /不是 Windows x64/); assert.equal(f.stopped.length, 0);
  assert.match(await readFile(join(f.installDir, metadata), 'utf8'), /preview.56/);
});

test('recovers a newer backup after an interrupted directory replacement', async () => {
  const f = await fixture(); await payload(f.installDir, '0.2.0-preview.58');
  await rename(f.installDir, join(dirname(f.installDir), '.RemoteDesktop.previous'));
  await f.app.prepare(); assert.equal((await f.app.describe()).version, '0.2.0-preview.58');
});

test('does not overwrite symlinks, unmanaged directories or unrelated user files', async () => {
  const f = await fixture(); await mkdir(dirname(f.installDir), { recursive: true }); await symlink(f.source, f.installDir, 'junction');
  await assert.rejects(f.app.prepare(), /不是普通目录/); await rm(f.installDir);
  await mkdir(f.installDir); await writeFile(join(f.installDir, 'user.txt'), 'keep');
  await assert.rejects(f.app.prepare(), /含有其他文件/); assert.equal(await readFile(join(f.installDir, 'user.txt'), 'utf8'), 'keep');
});

test('holds the installation lock through startup so a newer installer stops the completed old launch', async () => {
  const f = await fixture('0.2.0-preview.56'); let finish, ready;
  const launched = new Promise(resolve => { ready = resolve; });
  const starting = f.app.withPreparedApp(async path => { ready(); await new Promise(resolve => { finish = resolve; }); f.running.push({ pid: 22, path }); });
  await launched;
  const newer = join(f.root, 'newer/native'); await payload(newer, '0.2.0-preview.57');
  const app = new WindowsRemoteHelperApp({ ...f.options, sourcePath: join(newer, exe) }); const updating = app.prepare();
  finish(); await starting; await updating;
  assert.equal((await app.describe()).version, '0.2.0-preview.57'); assert.equal(f.stopped[0].pid, 22);
});
