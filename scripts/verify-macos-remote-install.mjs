import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RemoteHelper } from '../packages/server/lib/remote-control/helper-manager.mjs';
import { bundledRemoteAppPath, macHelperProcesses, MacRemoteHelperApp, stopMacHelperProcesses } from '../packages/server/lib/remote-control/macos-helper-app.mjs';

if (process.platform !== 'darwin') throw new Error('Run managed remote helper verification on macOS');
const root = await realpath(await mkdtemp(join(tmpdir(), 'agentroam-mac-install-')));
const appName = 'AgentRoam Remote Desktop.app', executable = 'Contents/MacOS/agentroam-remote-desktop';
const metadata = 'Contents/Resources/agentroam-component.json';
const source = resolve(process.argv[2] || bundledRemoteAppPath());
const sourcePath = join(root, 'current/runtime/native/Support.noindex', appName);
const oldSourcePath = join(root, 'old/runtime/native', appName);
const appPath = join(root, 'Application Support/AgentRoamRemoteDesktop/Services.noindex', appName);
const helpers = [], children = [], unregistered = [];
const processes = async () => (await macHelperProcesses()).filter(item => item.path.startsWith(root + '/'));
const options = { appPath, processes, register: async () => {}, unregister: async path => { unregistered.push(path); } };

async function launch(application) {
  let child;
  const helper = new RemoteHelper({ application, launch: async (control, video) => {
    child = spawn(join(application.appPath, executable), [control, video, String(process.pid)], { stdio: 'ignore' });
    children.push(child);
    await once(child, 'spawn');
  } });
  helpers.push(helper); await helper.start();
  assert.equal((await helper.request({ op: 'status' })).ok, true);
  return { helper, child };
}

try {
  await mkdir(join(root, 'current/runtime/native/Support.noindex'), { recursive: true });
  await cp(source, sourcePath, { recursive: true });
  const currentVersion = JSON.parse(await readFile(join(sourcePath, metadata), 'utf8')).version;
  await mkdir(join(root, 'old/runtime/native'), { recursive: true });
  await cp(source, oldSourcePath, { recursive: true });
  await writeFile(join(oldSourcePath, metadata), JSON.stringify({ bundleId: 'com.agentroam.remote-desktop', version: '0.0.0-preview.1' }));
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.agentroam.remote-desktop', oldSourcePath], { stdio: 'pipe' });
  await writeFile(join(root, 'old/package.json'), JSON.stringify({ name: 'agentroam-runtime-darwin-arm64', version: '0.0.0-preview.1' }));
  await writeFile(join(root, 'old/sessions.json'), 'keep session data');

  const oldApp = new MacRemoteHelperApp({ ...options, sourcePath: oldSourcePath });
  const first = await launch(oldApp);
  const identity = (await processes()).find(item => item.pid === first.child.pid);
  assert(identity, 'real helper must appear in process inventory');
  await assert.rejects(stopMacHelperProcesses([{ ...identity, identity: 'changed identity' }]), /身份已变化/);
  assert((await processes()).some(item => item.pid === first.child.pid), 'identity mismatch must not stop a process');

  const currentApp = new MacRemoteHelperApp({ ...options, sourcePath });
  const current = await launch(currentApp);
  assert(!(await processes()).some(item => item.pid === first.child.pid), 'old fixed helper must exit before replacement');
  assert.equal((await currentApp.describe()).version, currentVersion);
  assert.equal((await currentApp.describe()).updatePending, false);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
  const before = await stat(join(appPath, executable)); await currentApp.prepare(); const after = await stat(join(appPath, executable));
  assert.equal(before.ino, after.ino); assert.equal(before.mtimeMs, after.mtimeMs);

  const legacy = await launch({ appPath: oldSourcePath, available: async () => true, withPreparedApp: async use => use(oldSourcePath) });
  await currentApp.prepare();
  assert(!(await processes()).some(item => item.pid === legacy.child.pid));
  await assert.rejects(stat(oldSourcePath), { code: 'ENOENT' });
  assert(unregistered.includes(oldSourcePath));
  assert.equal(await readFile(join(root, 'old/sessions.json'), 'utf8'), 'keep session data');
  assert.equal((await current.helper.request({ op: 'status' })).ok, true);
  console.log(`Managed macOS helper verified: ${currentVersion}; real process identity guard, immediate replacement, strict signature, stable repeat install and legacy app cleanup passed.`);
  console.log('Permission grants, desktop input and iPhone keyboard behavior were not tested by this installation check.');
} finally {
  await Promise.allSettled(helpers.map(helper => helper.stop()));
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { child.kill('SIGTERM'); await exited; } finally { clearTimeout(timer); }
  }));
  await rm(root, { recursive: true, force: true });
}
