import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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

async function processPathsInUse() {
  const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', '-u', String(process.getuid()), '-d', 'txt', '-Fn'], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  const paths = stdout.split('\n').filter(line => line.startsWith('n/')).map(line => line.slice(1));
  if (!paths.length) throw new Error('无法确认旧远控组件是否仍在使用，请稍后重试');
  return paths;
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
  constructor({ sourcePath = bundledRemoteAppPath(), appPath = join(homedir(), 'Library/Application Support/AgentRoamRemoteDesktop/Services.noindex/AgentRoam Remote Desktop.app'), pathsInUse = processPathsInUse, verify = verifyBundle, register = registerApp, acquireLock = acquireMacInstallLock, lockTimeoutMs = 10000 } = {}) {
    Object.assign(this, { sourcePath, appPath, pathsInUse, verify, register, acquireLock, lockTimeoutMs });
    this.updatePending = false;
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
    return { name: 'AgentRoam Remote Desktop', path: this.appPath, version: installed?.version ?? source?.version ?? 'unknown', fingerprint: (installed ?? source)?.hash.slice(0, 12), installed: Boolean(installed), updatePending: this.updatePending, ...(this.updatePending ? { pendingVersion: source?.version } : {}) };
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
      const used = await this.pathsInUse();
      const installedExecutable = join(this.appPath, executable);
      const otherHelpers = used.filter(path => path.endsWith('/AgentRoam Remote Desktop.app/' + executable) && resolve(path) !== resolve(installedExecutable));
      if (otherHelpers.length) throw new Error('旧位置的远控组件仍在使用，请先结束旧版 AgentRoam 的桌面共享，再重新检测');
      // Repeated launches never rewrite an identical app. An older CLI cannot
      // roll the shared component back after a newer CLI has installed it.
      if (installed && (installed.hash === source.hash || installed.version !== 'legacy' && compareVersions(installed.version, source.version) >= 0)) {
        await this.verify(this.appPath);
        await this.registerInstalled(installed.hash);
        this.updatePending = false;
        return await use(this.appPath);
      }
      if (installed && used.includes(installedExecutable)) {
        await this.verify(this.appPath);
        await this.registerInstalled(installed.hash);
        this.updatePending = true;
        return await use(this.appPath);
      }
      const staging = await mkdtemp(join(dirname(this.appPath), '.remote-helper-update-'));
      const staged = join(staging, 'AgentRoam Remote Desktop.app');
      let moved = false;
      try {
        await cp(this.sourcePath, staged, { recursive: true, dereference: true });
        await this.verify(staged);
        if ((await readBundle(staged))?.hash !== source.hash) throw new Error('远控组件复制校验失败');
        if (existing) { await rename(this.appPath, backup); moved = true; }
        try { await rename(staged, this.appPath); }
        catch (error) {
          if (moved) {
            try { await rename(backup, this.appPath); moved = false; }
            catch { throw new Error(`远控组件更新失败，旧应用保留在 ${backup}`); }
          }
          throw error;
        }
        this.updatePending = false;
        await this.registerInstalled(source.hash);
        if (moved) await rm(backup, { recursive: true });
      } finally {
        // Backups are only removed after replacement; running old copies were
        // checked above. No permission records or user data are cleared.
        await rm(staging, { recursive: true, force: true });
      }
      return await use(this.appPath);
    } finally { await unlock(); }
  }
}
