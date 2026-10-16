import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { componentVersionPattern as versionPattern, compareComponentVersions as compareVersions } from './component-version.mjs';

const run = promisify(execFile);
const bundleId = 'com.agentroam.remote-desktop';
const executable = 'Contents/MacOS/agentroam-remote-desktop';
const metadata = 'Contents/Resources/agentroam-component.json';

export function bundledRemoteAppPath() {
  const native = fileURLToPath(new URL('../../native/', import.meta.url));
  const payload = join(native, 'Support.noindex/AgentRoam Remote Desktop.app');
  return existsSync(payload) ? payload : join(native, 'AgentRoam Remote Desktop.app');
}

async function readBundle(path) {
  try { await access(join(path, executable)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const plist = await readFile(join(path, 'Contents/Info.plist'), 'utf8');
  if (!/<key>CFBundleIdentifier<\/key>\s*<string>com\.agentroam\.remote-desktop<\/string>/.test(plist)) {
    throw new Error('远控组件应用标识不匹配，未覆盖现有应用');
  }
  let version = 'legacy';
  try {
    const value = JSON.parse(await readFile(join(path, metadata), 'utf8'));
    if (value.bundleId !== bundleId || !versionPattern.test(value.version)) throw new Error('远控组件版本信息无效');
    version = value.version;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const hash = createHash('sha256');
  async function visit(directory, relative = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name), target = join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, name);
      else if (entry.isFile()) { hash.update(name); hash.update('\0'); hash.update(await readFile(target)); hash.update('\0'); }
      else throw new Error('远控组件包含非普通文件，未安装');
    }
  }
  await visit(path);
  return { version, hash: hash.digest('hex') };
}

async function processIdentity(pid) {
  let stdout;
  try { ({ stdout } = await run('/bin/ps', ['-p', String(pid), '-o', 'uid=', '-o', 'lstart='], { timeout: 5000, maxBuffer: 4096 })); }
  catch (error) { if (error.code === 1) return null; throw error; }
  const match = /^(\d+)\s+(.+)$/.exec(stdout.trim());
  if (!match || Number(match[1]) !== process.getuid()) throw new Error('无法确认旧远控进程归属，未退出该进程');
  return stdout.trim().replace(/\s+/g, ' ');
}

export async function macHelperProcesses() {
  const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', '-u', String(process.getuid()), '-d', 'txt', '-Fpn'], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  const candidates = new Map();
  let pid;
  for (const line of stdout.split('\n')) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (pid && line.startsWith('n/') && line.endsWith('/AgentRoam Remote Desktop.app/' + executable)) candidates.set(pid, line.slice(1));
  }
  if (!/^p\d+$/m.test(stdout)) throw new Error('无法确认旧远控组件是否仍在使用，请稍后重试');
  const result = [];
  for (const [pid, path] of candidates) {
    const identity = await processIdentity(pid);
    if (identity) result.push({ pid, path, identity });
  }
  return result;
}

export async function stopMacHelperProcesses(processes) {
  for (const item of processes) {
    const current = (await macHelperProcesses()).find(p => p.pid === item.pid);
    if (!current) continue;
    if (current.path !== item.path || current.identity !== item.identity) throw new Error('旧远控进程身份已变化，未退出该进程');
    try { process.kill(item.pid, 'SIGTERM'); }
    catch (error) { if (error.code === 'ESRCH') continue; throw error; }
    const deadline = Date.now() + 10000;
    while (await processIdentity(item.pid) === item.identity) {
      if (Date.now() >= deadline) throw new Error('旧远控组件未退出，未替换现有应用');
      await delay(100);
    }
  }
}

async function verifyBundle(path) {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path], { timeout: 10000, maxBuffer: 4096 });
}

async function registerApp(path, oldPath) {
  const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  // Unregister the old launch target, retaining the package payload for repair.
  if (oldPath !== path) await run(register, ['-u', oldPath], { timeout: 5000, maxBuffer: 4096 }).catch(() => {});
  await run(register, ['-f', path], { timeout: 5000, maxBuffer: 4096 });
}

async function unregisterApp(path) {
  const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  await run(register, ['-u', path], { timeout: 5000, maxBuffer: 4096 });
}

export async function acquireMacInstallLock(path, timeoutMs) {
  const handle = await open(path, 'a', 0o600);
  try {
    // BSD flock belongs to the shared open-file description. lockf acquires
    // it on inherited fd 3; our handle retains it until close or process exit.
    // Keep the file so concurrent installers always lock the same inode.
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/lockf', ['-s', '-t', String(Math.ceil(timeoutMs / 1000)), '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(code === 75 ? '另一实例正在更新远控组件，请稍后重试' : '无法锁定远控组件安装位置')));
    });
    return () => handle.close();
  } catch (error) { await handle.close(); throw error; }
}

/** One installed app per user; npm version directories only carry its payload. */
export class MacRemoteHelperApp {
  constructor({ sourcePath = bundledRemoteAppPath(), appPath = join(homedir(), 'Library/Application Support/AgentRoamRemoteDesktop/Services.noindex/AgentRoam Remote Desktop.app'), processes = macHelperProcesses, stopProcesses = stopMacHelperProcesses, verify = verifyBundle, register = registerApp, unregister = unregisterApp, acquireLock = acquireMacInstallLock, lockTimeoutMs = 10000 } = {}) {
    Object.assign(this, { sourcePath, appPath, processes, stopProcesses, verify, register, unregister, acquireLock, lockTimeoutMs });
  }
  async available() { try { await access(join(this.sourcePath, executable)); return true; } catch { return false; } }
  async registerInstalled(hash) {
    if (this.registeredHash === hash) return;
    await this.register(this.appPath, this.sourcePath);
    this.registeredHash = hash;
  }
  async describe() {
    const installed = await readBundle(this.appPath);
    const source = await readBundle(this.sourcePath);
    return { name: 'AgentRoam Remote Desktop', path: this.appPath, version: installed?.version ?? source?.version ?? 'unknown', fingerprint: (installed ?? source)?.hash.slice(0, 12), installed: Boolean(installed), updatePending: false };
  }
  lock() { return this.acquireLock(join(dirname(this.appPath), '.remote-helper-install.lock'), this.lockTimeoutMs); }
  prepare() { return this.withPreparedApp(path => path); }
  async withPreparedApp(use) {
    await mkdir(dirname(this.appPath), { recursive: true, mode: 0o700 });
    const unlock = await this.lock();
    try {
      let existing = await lstat(this.appPath).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('远控组件安装位置不是普通应用目录，未覆盖');
      const backup = join(dirname(this.appPath), '.remote-helper-previous.app');
      const previous = await lstat(backup).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (previous) {
        if (!previous.isDirectory() || previous.isSymbolicLink() || !await readBundle(backup)) throw new Error('远控组件更新备份无效，未覆盖');
        // Recover a process exit between the two renames before considering
        // the current CLI's version, which might be older than the backup.
        if (!existing) {
          await this.verify(backup);
          await rename(backup, this.appPath);
          existing = await lstat(this.appPath);
        } else {
          if (!await readBundle(this.appPath)) throw new Error('远控组件更新未完成，已保留旧应用备份');
          await this.verify(this.appPath);
          await rm(backup, { recursive: true });
        }
      }
      const source = await readBundle(this.sourcePath);
      if (!source) throw new Error('当前 CLI 未包含远程授权组件，请升级 CLI');
      const installed = await readBundle(this.appPath);
      const installedExecutable = join(this.appPath, executable);
      // Repeated launches never rewrite an identical app. An older CLI cannot
      // roll the shared component back after a newer CLI has installed it.
      const keepInstalled = installed && (installed.hash === source.hash || installed.version !== 'legacy' && compareVersions(installed.version, source.version) >= 0);
      const targetVersion = keepInstalled ? installed.version : source.version;
      const running = await this.processes(), retired = [];
      for (const item of running.filter(item => resolve(item.path) !== resolve(installedExecutable))) {
        const path = item.path.slice(0, -('/' + executable).length);
        if (resolve(path) === resolve(this.sourcePath)) { retired.push({ ...item, appPath: path, remove: false }); continue; }
        const parent = dirname(path), native = parent.endsWith('/Support.noindex') ? dirname(parent) : parent;
        const pkg = JSON.parse(await readFile(join(native, '../../package.json'), 'utf8').catch(() => { throw new Error('无法确认旧远控组件归属，未退出该进程'); }));
        const info = await lstat(path);
        if (!native.endsWith('/runtime/native') || pkg.name !== 'agentroam-runtime-darwin-arm64' || !versionPattern.test(pkg.version) || !info.isDirectory() || info.isSymbolicLink()) throw new Error('无法确认旧远控组件归属，未退出该进程');
        const payload = await readBundle(path);
        if (!payload) throw new Error('旧远控组件文件不完整，未退出该进程');
        await this.verify(path);
        if (compareVersions(payload.version === 'legacy' ? pkg.version : payload.version, targetVersion) > 0) throw new Error('检测到较新的远控组件，请使用最新 CLI 更新');
        retired.push({ ...item, appPath: path, hash: payload.hash, remove: true });
      }
      const stop = [...retired, ...(!keepInstalled ? running.filter(item => resolve(item.path) === resolve(installedExecutable)) : [])];
      const retire = async () => {
        if (!stop.length) return;
        await this.stopProcesses(stop);
        const stoppedPaths = new Set(stop.map(item => resolve(item.path)));
        if ((await this.processes()).some(item => stoppedPaths.has(resolve(item.path)))) throw new Error('旧远控组件仍在使用，未替换现有应用');
      };
      const cleanup = async () => {
        for (const item of new Map(retired.filter(item => item.remove).map(item => [resolve(item.appPath), item])).values()) {
          if ((await readBundle(item.appPath))?.hash !== item.hash) throw new Error('旧远控组件已变化，未删除');
          if ((await this.processes()).some(process => resolve(process.path) === resolve(item.path))) throw new Error('旧远控组件重新启动，未删除');
          await this.unregister(item.appPath);
          await rm(item.appPath, { recursive: true });
        }
      };
      if (keepInstalled) {
        await this.verify(this.appPath);
        await retire();
        await this.registerInstalled(installed.hash);
        await cleanup();
        return await use(this.appPath);
      }
      const staging = await mkdtemp(join(dirname(this.appPath), '.remote-helper-update-'));
      const staged = join(staging, 'AgentRoam Remote Desktop.app');
      let moved = false;
      try {
        await cp(this.sourcePath, staged, { recursive: true, dereference: true });
        await this.verify(staged);
        if ((await readBundle(staged))?.hash !== source.hash) throw new Error('远控组件复制校验失败');
        await retire();
        if (existing) { await rename(this.appPath, backup); moved = true; }
        try { await rename(staged, this.appPath); }
        catch (error) {
          if (moved) {
            try { await rename(backup, this.appPath); moved = false; }
            catch { throw new Error(`远控组件更新失败，旧应用保留在 ${backup}`); }
          }
          throw error;
        }
        await this.registerInstalled(source.hash);
        if (moved) await rm(backup, { recursive: true });
        await cleanup();
      } finally {
        // Backups are removed only after replacement. Permission records and
        // user data are not part of component cleanup.
        await rm(staging, { recursive: true, force: true });
      }
      return await use(this.appPath);
    } finally { await unlock(); }
  }
}
