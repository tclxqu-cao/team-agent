import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WindowsRemoteHelper } from '../packages/server/lib/remote-control/windows-helper.mjs';
import { acquireWindowsInstallLock, WindowsRemoteHelperApp, WINDOWS_HELPER_EXECUTABLE as exe, WINDOWS_HELPER_METADATA as metadata, windowsHelperProcesses } from '../packages/server/lib/remote-control/windows-helper-app.mjs';

if (process.platform !== 'win32') throw new Error('Run managed remote helper verification on Windows');
const root = await mkdtemp(join(tmpdir(), 'agentroam-fixed-helper-'));
const sourcePath = resolve('packages/server/native/.build-remote/windows', exe);
const installDir = join(root, 'Local AppData/AgentRoam/RemoteDesktop');
const oldPayload = join(root, 'old/runtime/native');
const helpers = [];
async function copyOldPayload(directory) {
  await mkdir(directory, { recursive: true });
  for (const name of [exe, 'remote-helper-NOTICES.txt', metadata]) await copyFile(join(dirname(sourcePath), name), join(directory, name));
  const value = JSON.parse(await readFile(join(directory, metadata), 'utf8')); value.version = '0.0.0-preview.1';
  await writeFile(join(directory, metadata), JSON.stringify(value));
}

try {
  // Exercise real Windows pipe exclusivity and release when an owner crashes.
  const unlock = await acquireWindowsInstallLock(installDir, 0);
  try { await assert.rejects(acquireWindowsInstallLock(installDir.toUpperCase(), 0), /另一实例/); }
  finally { await unlock(); }
  const module = new URL('../packages/server/lib/remote-control/windows-helper-app.mjs', import.meta.url).href;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireWindowsInstallLock } from ${JSON.stringify(module)}; const release = await acquireWindowsInstallLock(${JSON.stringify(installDir)}, 0); process.stdout.write('ready');`], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await Promise.race([once(owner.stdout, 'data'), once(owner, 'exit').then(() => { throw new Error('lock owner exited before readiness'); })]);
    const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
  } finally { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL'); }
  await (await acquireWindowsInstallLock(installDir, 5000))();

  await copyOldPayload(oldPayload);
  await writeFile(join(oldPayload, '../../package.json'), JSON.stringify({ name: 'agentroam-runtime-win32-x64', version: '0.0.0-preview.1' }));
  await writeFile(join(oldPayload, 'agentroam-remote-unlock.exe'), 'preserve separate service');
  const oldApp = new WindowsRemoteHelperApp({ sourcePath: join(oldPayload, exe), installDir }); await oldApp.prepare();
  const first = new WindowsRemoteHelper({ executable: oldApp.executable }); helpers.push(first); await first.start(); const oldChild = first.child;
  const currentApp = new WindowsRemoteHelperApp({ sourcePath, installDir });
  const current = new WindowsRemoteHelper({ application: currentApp }); helpers.push(current); await current.start();
  assert.notEqual(oldChild.exitCode, null, 'old installed process must exit before replacement');
  assert.equal(current.child.spawnfile, join(installDir, exe));
  const identity = await current.describe();
  const sourceVersion = JSON.parse(await readFile(join(dirname(sourcePath), metadata), 'utf8')).version;
  assert.equal(identity.version, sourceVersion); assert.equal(identity.updatePending, false);
  assert((await windowsHelperProcesses()).some(p => p.pid === current.child.pid && p.path.toLowerCase() === currentApp.executable.toLowerCase()));
  const before = await stat(currentApp.executable); await currentApp.prepare(); const after = await stat(currentApp.executable);
  assert.equal(before.ino, after.ino); assert.equal(before.mtimeMs, after.mtimeMs);

  // A real legacy runtime process is removed without removing its unlock service.
  const legacy = new WindowsRemoteHelper({ executable: join(oldPayload, exe) }); helpers.push(legacy); await legacy.start();
  const legacyChild = legacy.child; await currentApp.prepare();
  assert.notEqual(legacyChild.exitCode, null);
  await assert.rejects(readFile(join(oldPayload, exe)), { code: 'ENOENT' });
  assert.equal(await readFile(join(oldPayload, 'agentroam-remote-unlock.exe'), 'utf8'), 'preserve separate service');
  assert.equal((await current.request({ op: 'status' })).ok, true);
  console.log(`Managed Windows helper verified: ${sourceVersion}; fixed path, crash-released lock, real process retirement, replacement, repeat launch and legacy cleanup passed.`);
  console.log('Logged-in desktop input, UAC/lock behavior and phone playback were not tested by this installation check.');
} finally {
  await Promise.all(helpers.map(helper => helper.stop()));
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
