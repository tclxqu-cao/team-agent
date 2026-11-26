import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireMacInstallLock, MacRemoteHelperApp } from './macos-helper-app.mjs';
import { MacHelperPermissions } from './macos-helper-permissions.mjs';

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
async function installedEntries(path: string) {
  return (await readdir(dirname(path))).filter(name => name !== '.remote-helper-install.lock' && name !== '.remote-helper-permissions.json');
}

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
  const verify = vi.fn(async () => {}), register = vi.fn(async () => {}), unregister = vi.fn(async () => {});
  const processes = async () => paths.map((path, index) => ({ pid: 1000 + index, path, identity: 'test identity' }));
  const stopProcesses = vi.fn(async items => {
    for (const item of items) { const index = paths.indexOf(item.path); if (index >= 0) paths.splice(index, 1); }
  });
  const reset = vi.fn(async (_service: string) => {}), requiresNewGrant = vi.fn(async () => false);
  const permissionFile = join(dirname(appPath), '.remote-helper-permissions.json');
  const buildSpecific = vi.fn(async () => false);
  const permissions = new MacHelperPermissions(permissionFile, { reset, requiresNewGrant, buildSpecific });
  const registeredCopies = vi.fn(async (): Promise<string[]> => []);
  const options = { sourcePath, appPath, verify, register, unregister, registeredCopies, processes, stopProcesses, permissions, ...(process.platform === 'darwin' ? {} : { acquireLock: testLock }) };
  return { root, sourcePath, appPath, paths, verify, register, unregister, registeredCopies, stopProcesses, reset, requiresNewGrant, buildSpecific, permissionFile, options, app: new MacRemoteHelperApp(options) };
}

async function legacyBundle(root: string, version: string | null = '0.2.0-preview.53', indexed = false) {
  const path = join(root, 'old/runtime/native', indexed ? 'Support.noindex' : '', 'AgentRoam Remote Desktop.app');
  await bundle(path, version);
  await writeFile(join(root, 'old/package.json'), JSON.stringify({ name: 'agentroam-runtime-darwin-arm64', version: version ?? '0.2.0-preview.53' }));
  await writeFile(join(root, 'old/session.json'), 'keep session');
  return path;
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

it('stops the running old component, replaces it immediately and removes its backup', async () => {
  const f = await fixture(); await bundle(f.appPath, '0.2.0-preview.53');
  f.paths.push(join(f.appPath, executable));
  await f.app.prepare();
  expect(await f.app.describe()).toMatchObject({ version: '0.2.0-preview.54', updatePending: false });
  expect(f.stopProcesses).toHaveBeenCalledWith([expect.objectContaining({ path: join(f.appPath, executable) })]);
  expect(await installedEntries(f.appPath)).toEqual(['AgentRoam Remote Desktop.app']);
});

it.each([false, true])('stops and removes a recognized old npm app (noindex=%s), preserving its CLI and sessions', async indexed => {
  const f = await fixture(); const oldPath = await legacyBundle(f.root, null, indexed);
  f.paths.push(join(oldPath, executable), join(oldPath, executable));
  await f.app.prepare();
  await expect(readFile(join(oldPath, executable))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.unregister).toHaveBeenCalledWith(oldPath);
  expect(await readFile(join(f.root, 'old/session.json'), 'utf8')).toBe('keep session');
  expect(JSON.parse(await readFile(join(f.root, 'old/package.json'), 'utf8')).name).toBe('agentroam-runtime-darwin-arm64');
  expect((await f.app.describe()).installed).toBe(true);
});

it('cleans a legacy app while keeping an already current fixed app unchanged', async () => {
  const f = await fixture(); await f.app.prepare();
  const oldPath = await legacyBundle(f.root); f.paths.push(join(oldPath, executable));
  const before = await stat(join(f.appPath, executable)); await f.app.prepare();
  await expect(readFile(join(oldPath, executable))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await stat(join(f.appPath, executable))).ino).toBe(before.ino);
});

it('stops a running source payload for migration but retains it as a repair resource', async () => {
  const f = await fixture(); f.paths.push(join(f.sourcePath, executable));
  await f.app.prepare();
  expect(f.paths).toEqual([]);
  expect(await readFile(join(f.sourcePath, executable), 'utf8')).toBe('0.2.0-preview.54');
});

it('does not stop an app with unknown ownership or a newer npm component', async () => {
  const f = await fixture(); f.paths.push(join(f.root, 'unknown/AgentRoam Remote Desktop.app', executable));
  await expect(f.app.prepare()).rejects.toThrow('无法确认旧远控组件归属');
  expect(f.stopProcesses).not.toHaveBeenCalled();
  const newer = await legacyBundle(f.root, '0.2.0-preview.55'); f.paths.splice(0, 1, join(newer, executable));
  await expect(f.app.prepare()).rejects.toThrow('较新的远控组件');
  expect(f.stopProcesses).not.toHaveBeenCalled();
  expect((await f.app.describe()).installed).toBe(false);
});

it('keeps the old installation if a process cannot be stopped or restarts immediately', async () => {
  const f = await fixture(); await bundle(f.appPath, '0.2.0-preview.53'); f.paths.push(join(f.appPath, executable));
  f.stopProcesses.mockRejectedValueOnce(new Error('stop denied'));
  await expect(f.app.prepare()).rejects.toThrow('stop denied');
  expect((await f.app.describe()).version).toBe('0.2.0-preview.53');
  f.stopProcesses.mockImplementationOnce(async () => {});
  await expect(f.app.prepare()).rejects.toThrow('旧远控组件仍在使用');
  expect((await f.app.describe()).version).toBe('0.2.0-preview.53');
});

it('keeps the old installed app if signature verification of its replacement fails', async () => {
  const f = await fixture(); await bundle(f.appPath, '0.2.0-preview.53');
  f.paths.push(join(f.appPath, executable));
  f.verify.mockRejectedValueOnce(new Error('invalid code signature'));
  await expect(f.app.prepare()).rejects.toThrow('invalid code signature');
  expect(await readFile(join(f.appPath, executable), 'utf8')).toBe('0.2.0-preview.53');
  expect(await installedEntries(f.appPath)).toEqual(['AgentRoam Remote Desktop.app']);
  expect(f.stopProcesses).not.toHaveBeenCalled();
});

it('does not replace the component when process inspection fails', async () => {
  const f = await fixture(); await bundle(f.appPath, '0.2.0-preview.53');
  const app = new MacRemoteHelperApp({ ...f.options, processes: async () => { throw new Error('process inventory unavailable'); } });
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
  expect(await newer.describe()).toMatchObject({ version: '0.2.0-preview.54', updatePending: false });
  expect(f.paths).toEqual([]);
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

it('cleans old grants once per permission across clients after a verified incompatible upgrade', async () => {
  const f = await fixture();
  await bundle(f.appPath, '0.2.0-preview.53');
  f.requiresNewGrant.mockResolvedValue(true);
  const fingerprint = await f.app.withPreparedApp((_path: string, hash: string) => hash);
  const second = new MacRemoteHelperApp({ ...f.options, permissions: new MacHelperPermissions(f.permissionFile, { reset: f.reset }) });
  await second.prepare(); await second.describe();
  expect(f.reset).not.toHaveBeenCalled();
  const probe = vi.fn(async () => ({ screen: false, accessibility: false, locked: false }));
  await Promise.all([f.app, second].map(client => client.beforePermissionPrompt(fingerprint, 'screen', probe)));
  expect(f.reset.mock.calls).toEqual([['ScreenCapture']]);
  await second.beforePermissionPrompt(fingerprint, 'accessibility', probe);
  await f.app.beforePermissionPrompt(fingerprint, 'accessibility', probe);
  expect(f.reset.mock.calls).toEqual([['ScreenCapture'], ['Accessibility']]);
  expect(probe).toHaveBeenCalledTimes(2);
});

it('preserves current grants and waits for an unlocked, affirmative permission probe', async () => {
  const f = await fixture(); await bundle(f.appPath, '0.2.0-preview.53');
  f.requiresNewGrant.mockResolvedValue(true);
  const hash = await f.app.withPreparedApp((_path: string, hash: string) => hash);
  for (const locked of [true, null]) {
    await f.app.beforePermissionPrompt(hash, 'screen', async () => ({ screen: false, accessibility: true, locked }));
  }
  await f.app.beforePermissionPrompt(hash, 'screen', async () => ({ screen: undefined, locked: false }));
  expect(f.reset).not.toHaveBeenCalled();
  await f.app.beforePermissionPrompt(hash, 'screen', async () => ({ screen: false, accessibility: true, locked: false }));
  await f.app.beforePermissionPrompt(hash, 'accessibility', async () => ({ accessibility: false, locked: false }));
  expect(f.reset.mock.calls).toEqual([['ScreenCapture']]);
});

it.skipIf(process.platform === 'win32')('unregisters only verified obsolete copies before resetting and retains backup files', async () => {
  const f = await fixture();
  await bundle(f.appPath, '0.2.0-preview.53');
  f.requiresNewGrant.mockResolvedValue(true);
  const hash = await f.app.withPreparedApp((_path: string, hash: string) => hash);
  const old = join(f.root, 'Documents/retired.app'), newer = join(f.root, 'later.app');
  const alternate = join(f.root, 'same-version-different-binary.app'), unrelated = join(f.root, 'unrelated.app');
  await bundle(old, '0.2.0-preview.53');
  await bundle(newer, '0.2.0-preview.99');
  await bundle(alternate, '0.2.0-preview.54', 'different build');
  await bundle(unrelated, '0.2.0-preview.40');
  await writeFile(join(unrelated, 'Contents/Info.plist'), '<key>CFBundleIdentifier</key><string>example.other</string>');
  f.registeredCopies.mockResolvedValue([f.appPath, old, old, f.sourcePath, newer, alternate, unrelated]);
  await f.app.beforePermissionPrompt(hash, 'screen', async () => ({ screen: false, locked: true }));
  expect(f.registeredCopies).not.toHaveBeenCalled();
  await f.app.beforePermissionPrompt(hash, 'screen', async () => ({ screen: false, locked: false }));
  expect(f.unregister.mock.calls).toEqual([[old], [f.sourcePath]]);
  expect(f.register).toHaveBeenLastCalledWith(f.appPath, f.appPath);
  expect(f.register.mock.invocationCallOrder.at(-1)).toBeLessThan(f.reset.mock.invocationCallOrder[0]);
  expect(await readFile(join(old, executable), 'utf8')).toBe('0.2.0-preview.53');
  expect(await readFile(join(f.sourcePath, executable), 'utf8')).toBe('0.2.0-preview.54');
});

it('does not clear permissions on first install, signature-compatible upgrades or when an older client reopens them', async () => {
  const f = await fixture(), probe = vi.fn(async () => ({ screen: false, locked: false }));
  f.buildSpecific.mockResolvedValue(true);
  let hash = await f.app.withPreparedApp((_path: string, value: string) => value);
  await f.app.beforePermissionPrompt(hash, 'screen', probe);
  const source = join(f.root, 'newer/AgentRoam Remote Desktop.app');
  await bundle(source, '0.2.0-preview.55');
  const newer = new MacRemoteHelperApp({ ...f.options, sourcePath: source });
  hash = await newer.withPreparedApp((_path: string, value: string) => value);
  await newer.beforePermissionPrompt(hash, 'screen', probe);
  await f.app.prepare(); await f.app.beforePermissionPrompt(hash, 'screen', probe);
  expect(f.requiresNewGrant).toHaveBeenCalledOnce();
  expect(probe).not.toHaveBeenCalled();
  expect(f.reset).not.toHaveBeenCalled();
  expect(f.buildSpecific).not.toHaveBeenCalled();
});

it('repairs an explicitly requested missing grant of a preexisting ad hoc installation once, even after the old binary was discarded', async () => {
  const f = await fixture(); await bundle(f.appPath, '0.2.0-preview.54');
  f.buildSpecific.mockResolvedValue(true);
  const hash = await f.app.withPreparedApp((_path: string, hash: string) => hash);
  expect(f.buildSpecific).toHaveBeenCalledWith(f.appPath);
  expect(f.reset).not.toHaveBeenCalled();
  expect((await stat(f.permissionFile)).mode & 0o777).toBe(0o600);
  f.reset.mockRejectedValueOnce(Object.assign(new Error('temporarily busy'), { code: 1 }));
  const probe = async () => ({ screen: true, accessibility: false, locked: false });
  await expect(f.app.beforePermissionPrompt(hash, 'accessibility', probe)).resolves.toBe(false);
  await expect(f.app.beforePermissionPrompt(hash, 'accessibility', probe)).resolves.toBe(true);
  await f.app.prepare();
  await f.app.beforePermissionPrompt(hash, 'screen', probe);
  await f.app.beforePermissionPrompt(hash, 'accessibility', probe);
  expect(f.reset.mock.calls).toEqual([['Accessibility'], ['Accessibility']]);
  expect(f.buildSpecific).toHaveBeenCalledOnce();
  expect(f.requiresNewGrant).not.toHaveBeenCalled();
});

it('recovers a pending migration after replacement and carries the remaining permissions across a compatible update', async () => {
  const f = await fixture(); await f.app.prepare();
  await bundle(join(dirname(f.appPath), '.remote-helper-previous.app'), '0.2.0-preview.53');
  f.requiresNewGrant.mockResolvedValueOnce(true);
  const oldHash = await f.app.withPreparedApp((_path: string, hash: string) => hash);
  const probe = async () => ({ screen: false, accessibility: false, locked: false });
  await f.app.beforePermissionPrompt(oldHash, 'screen', probe);
  const newerSource = join(f.root, 'newer/AgentRoam Remote Desktop.app'); await bundle(newerSource, '0.2.0-preview.55');
  const newer = new MacRemoteHelperApp({ ...f.options, sourcePath: newerSource });
  const hash = await newer.withPreparedApp((_path: string, hash: string) => hash);
  await f.app.beforePermissionPrompt(oldHash, 'accessibility', probe);
  await newer.beforePermissionPrompt(hash, 'screen', probe);
  expect(f.reset.mock.calls).toEqual([['ScreenCapture']]);
  await newer.beforePermissionPrompt(hash, 'accessibility', probe);
  expect(f.reset.mock.calls).toEqual([['ScreenCapture'], ['Accessibility']]);
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
