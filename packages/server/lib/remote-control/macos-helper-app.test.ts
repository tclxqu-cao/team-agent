import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireMacInstallLock, MacRemoteHelperApp } from './macos-helper-app.mjs';

const executable = 'Contents/MacOS/agentroam-remote-desktop';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const queues = new Map<string, Promise<void>>();
// Non-macOS CI checks installation policy with an injected mutex. macOS also
// exercises the real OS lock, including release after an installer crash.
async function testLock(path: string) {
  const previous = queues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  queues.set(path, next); await previous;
  return async () => { release(); if (queues.get(path) === next) queues.delete(path); };
}
async function installedEntries(path: string) { return (await readdir(dirname(path))).filter(name => name !== '.remote-helper-install.lock'); }

async function bundle(path: string, version: string | null, bytes = version ?? 'old') {
  await mkdir(join(path, 'Contents/MacOS'), { recursive: true });
  await mkdir(join(path, 'Contents/Resources'), { recursive: true });
  await writeFile(join(path, executable), bytes);
  await writeFile(join(path, 'Contents/Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.agentroam.remote-desktop</string></dict></plist>');
  if (version) await writeFile(join(path, 'Contents/Resources/agentroam-component.json'), JSON.stringify({ bundleId: 'com.agentroam.remote-desktop', version }));
}

async function fixture(version = '0.2.0-preview.54') {
  const root = await mkdtemp(join(tmpdir(), 'agentroam-helper-app-')); roots.push(root);
  const sourcePath = join(root, 'runtime/native/Support.noindex/AgentRoam Remote Desktop.app');
  const appPath = join(root, 'Application Support/AgentRoamRemoteDesktop/Services.noindex/AgentRoam Remote Desktop.app');
  await bundle(sourcePath, version);
  const paths: string[] = [];
  const verify = vi.fn(async () => {}), register = vi.fn(async () => {});
  const options = { sourcePath, appPath, verify, register, pathsInUse: async () => paths, ...(process.platform === 'darwin' ? {} : { acquireLock: testLock }) };
  return { root, sourcePath, appPath, paths, verify, register, options, app: new MacRemoteHelperApp(options) };
}

it('installs the bundled payload at one fixed path and reports the installed version', async () => {
  const f = await fixture();
  expect(await f.app.available()).toBe(true);
  expect(await f.app.describe()).toMatchObject({ path: f.appPath, installed: false });
  expect(await f.app.prepare()).toBe(f.appPath);
  expect(await readFile(join(f.appPath, executable), 'utf8')).toBe('0.2.0-preview.54');
  expect(await f.app.describe()).toMatchObject({ path: f.appPath, version: '0.2.0-preview.54', installed: true, updatePending: false });
  expect(f.verify).toHaveBeenCalledOnce();
  expect(f.register).toHaveBeenCalledWith(f.appPath, f.sourcePath);
  expect(await installedEntries(f.appPath)).toEqual(['AgentRoam Remote Desktop.app']);
});

it('does not rewrite an identical authorized app on repeated starts', async () => {
  const f = await fixture(); await f.app.prepare();
  const before = await stat(join(f.appPath, executable));
  f.paths.push(join(f.appPath, executable));
  await f.app.prepare();
  expect((await stat(join(f.appPath, executable))).ino).toBe(before.ino);
  expect((await stat(join(f.appPath, executable))).mtimeMs).toBe(before.mtimeMs);
  expect(f.register).toHaveBeenCalledOnce();
});

it('replaces a stopped legacy app and removes the superseded installation backup', async () => {
  const f = await fixture(); await bundle(f.appPath, null);
  await f.app.prepare();
  expect(await f.app.describe()).toMatchObject({ version: '0.2.0-preview.54', updatePending: false });
  expect(await installedEntries(f.appPath)).toEqual(['AgentRoam Remote Desktop.app']);
  // The npm payload stays available for repair, but is never the launch target.
  expect(await readFile(join(f.sourcePath, executable), 'utf8')).toBe('0.2.0-preview.54');
});

it.each(['0.2.0-preview.54', '0.2.0-preview.55', '0.2.0'])('never downgrades an installed %s component when an older CLI starts', async (version) => {
  const f = await fixture('0.2.0-preview.53'); await bundle(f.appPath, version, 'keep newer');
  await f.app.prepare();
  expect(await readFile(join(f.appPath, executable), 'utf8')).toBe('keep newer');
  expect((await f.app.describe()).version).toBe(version);
});

it('defers an update while another gateway still uses the installed executable', async () => {
  const f = await fixture(); await bundle(f.appPath, '0.2.0-preview.53');
  f.paths.push(join(f.appPath, executable));
  await f.app.prepare();
  expect(await f.app.describe()).toMatchObject({ version: '0.2.0-preview.53', updatePending: true, pendingVersion: '0.2.0-preview.54' });
  expect(await readFile(join(f.appPath, executable), 'utf8')).toBe('0.2.0-preview.53');
  f.paths.length = 0;
  await f.app.prepare();
  expect(await f.app.describe()).toMatchObject({ version: '0.2.0-preview.54', updatePending: false });
});

it('does not migrate while an app from an old package location is still running', async () => {
  const f = await fixture(); f.paths.push(join(f.root, 'old-cli/native/AgentRoam Remote Desktop.app', executable));
  await expect(f.app.prepare()).rejects.toThrow('旧位置的远控组件仍在使用');
  expect((await f.app.describe()).installed).toBe(false);
  expect(f.register).not.toHaveBeenCalled();
});

it('refuses a second launch while an old package helper runs even if the fixed app is current', async () => {
  const f = await fixture(); await f.app.prepare();
  f.paths.push(join(f.root, 'old-cli/native/AgentRoam Remote Desktop.app', executable));
  await expect(f.app.prepare()).rejects.toThrow('旧位置的远控组件仍在使用');
});

it('keeps the old installed app if signature verification of its replacement fails', async () => {
  const f = await fixture(); await bundle(f.appPath, '0.2.0-preview.53');
  f.verify.mockRejectedValueOnce(new Error('invalid code signature'));
  await expect(f.app.prepare()).rejects.toThrow('invalid code signature');
  expect(await readFile(join(f.appPath, executable), 'utf8')).toBe('0.2.0-preview.53');
  expect(await installedEntries(f.appPath)).toEqual(['AgentRoam Remote Desktop.app']);
});

it('does not replace the component when process inspection fails', async () => {
  const f = await fixture(); await bundle(f.appPath, '0.2.0-preview.53');
  const app = new MacRemoteHelperApp({ ...f.options, pathsInUse: async () => { throw new Error('process inventory unavailable'); } });
  await expect(app.prepare()).rejects.toThrow('process inventory unavailable');
  expect(await readFile(join(f.appPath, executable), 'utf8')).toBe('0.2.0-preview.53');
});

it('refuses to overwrite a symlink or an unrelated app at the installation path', async () => {
  const f = await fixture(); await mkdir(dirname(f.appPath), { recursive: true });
  await symlink(f.sourcePath, f.appPath);
  await expect(f.app.prepare()).rejects.toThrow('不是普通应用目录');
  await rm(f.appPath);
  await bundle(f.appPath, null);
  await writeFile(join(f.appPath, 'Contents/Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>other.app</string></dict></plist>');
  await expect(f.app.prepare()).rejects.toThrow('应用标识不匹配');
});

it('holds the update lock until launch finishes so a concurrent installer sees the new process', async () => {
  const f = await fixture('0.2.0-preview.53');
  let finish!: () => void, launched!: () => void;
  const ready = new Promise<void>(resolve => { launched = resolve; });
  const starting = f.app.withPreparedApp(async () => {
    launched(); await new Promise<void>(resolve => { finish = resolve; });
    f.paths.push(join(f.appPath, executable));
  });
  await ready;
  const newerSource = join(f.root, 'newer/AgentRoam Remote Desktop.app'); await bundle(newerSource, '0.2.0-preview.54');
  const newer = new MacRemoteHelperApp({ ...f.options, sourcePath: newerSource });
  const updating = newer.prepare();
  finish(); await starting; await updating;
  expect(await newer.describe()).toMatchObject({ version: '0.2.0-preview.53', updatePending: true });
});

it('recovers the newer backup after an installer exits between replacement renames', async () => {
  const f = await fixture('0.2.0-preview.53'); await bundle(f.appPath, '0.2.0-preview.55');
  await rename(f.appPath, join(dirname(f.appPath), '.remote-helper-previous.app'));
  await f.app.prepare();
  expect((await f.app.describe()).version).toBe('0.2.0-preview.55');
  expect(await installedEntries(f.appPath)).toEqual(['AgentRoam Remote Desktop.app']);
});

it('cleans the backup after an installer exits with the replacement already installed', async () => {
  const f = await fixture(); await f.app.prepare();
  await bundle(join(dirname(f.appPath), '.remote-helper-previous.app'), '0.2.0-preview.53');
  const before = await stat(join(f.appPath, executable)); await f.app.prepare();
  expect((await stat(join(f.appPath, executable))).ino).toBe(before.ino);
  expect(await installedEntries(f.appPath)).toEqual(['AgentRoam Remote Desktop.app']);
});

it.skipIf(process.platform !== 'darwin')('retains the OS lock until release and can reuse its file', async () => {
  const f = await fixture(); const path = join(f.root, 'lock');
  const unlock = await acquireMacInstallLock(path, 0);
  try { await expect(acquireMacInstallLock(path, 0)).rejects.toThrow('另一实例'); }
  finally { await unlock(); }
  await (await acquireMacInstallLock(path, 0))();
});

it.skipIf(process.platform !== 'darwin')('releases the OS lock automatically if the installer process crashes', async () => {
  const f = await fixture(); const path = join(f.root, 'lock');
  const module = new URL('./macos-helper-app.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireMacInstallLock } from ${JSON.stringify(module)}; const unlock = await acquireMacInstallLock(${JSON.stringify(path)}, 0); process.stdout.write('ready'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => resolve()); child.once('exit', () => reject(new Error('lock owner exited before ready'))); });
    await expect(acquireMacInstallLock(path, 0)).rejects.toThrow('另一实例');
  } finally { child.kill('SIGKILL'); await exited; }
  await (await acquireMacInstallLock(path, 0))();
});
