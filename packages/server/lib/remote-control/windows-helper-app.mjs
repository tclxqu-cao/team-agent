import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { componentVersionPattern, compareComponentVersions } from './component-version.mjs';

const run = promisify(execFile);
export const WINDOWS_HELPER_EXECUTABLE = 'agentroam-remote-desktop.exe';
export const WINDOWS_HELPER_METADATA = 'agentroam-remote-component.json';
const payloadFiles = [WINDOWS_HELPER_EXECUTABLE, 'remote-helper-NOTICES.txt'];
const component = 'agentroam-remote-desktop';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = path => win32.normalize(path).toLowerCase();

export function bundledWindowsHelperPath() {
  const native = fileURLToPath(new URL('../../native/', import.meta.url));
  const bundled = join(native, WINDOWS_HELPER_EXECUTABLE), development = join(native, '.build-remote/windows', WINDOWS_HELPER_EXECUTABLE);
  return existsSync(bundled) || !existsSync(development) ? bundled : development;
}

export function windowsHelperInstallDirectory({ localAppData = process.env.LOCALAPPDATA, home = homedir() } = {}) {
  if (localAppData && !win32.isAbsolute(localAppData)) throw new Error('LOCALAPPDATA 必须是绝对路径');
  return win32.join(localAppData || win32.join(home, 'AppData/Local'), 'AgentRoam/RemoteDesktop');
}

/** A Windows pipe disappears on process exit, so no stale PID file is removed. */
export async function acquireWindowsInstallLock(directory, timeoutMs = 10000) {
  const pipe = '\\\\.\\pipe\\agentroam-remote-install-' + hash(canonical(directory));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
      return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
      if (Date.now() >= deadline) throw new Error('另一实例正在更新远控组件，请稍后重试');
      await delay(Math.min(100, deadline - Date.now()));
    }
  }
}

export async function windowsHelperProcesses() {
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$items = @(Get-CimInstance Win32_Process -Filter "Name = 'agentroam-remote-desktop.exe'" | ForEach-Object {
  if ([string]::IsNullOrWhiteSpace($_.ExecutablePath)) { throw 'Cannot inspect remote helper executable' }
  @{ pid = $_.ProcessId; path = $_.ExecutablePath }
})
ConvertTo-Json -InputObject $items -Compress`;
  const { stdout } = await runPowerShell(script);
  const processes = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  if (!Array.isArray(processes) || processes.some(item => !Number.isSafeInteger(item.pid) || item.pid <= 0 || typeof item.path !== 'string' || !win32.isAbsolute(item.path))) throw new Error('无法确认旧远控组件是否仍在使用，请稍后重试');
  return processes;
}

function runPowerShell(script, options = {}) {
  const powershell = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true, ...options });
}

export async function stopWindowsHelperProcesses(processes) {
  if (!processes.length) return;
  const script = `$ErrorActionPreference = 'Stop'
$items = ConvertFrom-Json $env:AGENTROAM_RETIRE_HELPERS
foreach ($item in $items) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.pid)"
  if ($null -eq $current) { continue }
  if ($current.Name -ine 'agentroam-remote-desktop.exe' -or $current.ExecutablePath -ine $item.path) { throw 'Remote helper process identity changed' }
  try { $process = [System.Diagnostics.Process]::GetProcessById($item.pid) } catch [System.ArgumentException] { continue }
  try {
    $handle = $process.Handle
    $again = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.pid)"
    if ($null -eq $again) { continue }
    if ($again.CreationDate -ne $current.CreationDate -or $again.ExecutablePath -ine $item.path) { throw 'Remote helper process identity changed' }
    $process.Kill()
    if (-not $process.WaitForExit(10000)) { throw 'Remote helper did not exit' }
  } finally { $process.Dispose() }
}`;
  await runPowerShell(script, { env: { ...process.env, AGENTROAM_RETIRE_HELPERS: JSON.stringify(processes) } });
}

async function entry(path) { return lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }); }

async function readPayload(directory, managed = false) {
  const root = await entry(directory);
  if (!root) return null;
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('远控组件安装位置不是普通目录，未覆盖');
  if (managed && (await readdir(directory)).some(name => ![...payloadFiles, WINDOWS_HELPER_METADATA].includes(name))) throw new Error('远控组件安装位置含有其他文件，未覆盖');
  const files = {};
  for (const name of payloadFiles) {
    const path = join(directory, name), info = await entry(path);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`远控组件缺少普通文件：${name}`);
    const bytes = await readFile(path);
    if (name === WINDOWS_HELPER_EXECUTABLE) {
      const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : bytes.length;
      if (bytes.toString('ascii', 0, 2) !== 'MZ' || offset + 6 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('远控组件不是 Windows x64 程序');
    }
    files[name] = hash(bytes);
  }
  let version = 'legacy';
  const metadataPath = join(directory, WINDOWS_HELPER_METADATA), metadata = await entry(metadataPath);
  if (metadata) {
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('远控组件版本信息无效');
    const value = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (value.component !== component || !(value.version === 'legacy' || componentVersionPattern.test(value.version))) throw new Error('远控组件版本信息无效');
    if (!value.files || Object.keys(value.files).length !== payloadFiles.length || payloadFiles.some(name => value.files[name] !== files[name])) throw new Error('远控组件文件校验失败');
    version = value.version;
  } else if (managed) throw new Error('安装位置不是 AgentRoam 管理的远控组件，未覆盖');
  const manifest = { component, version, files };
  return { manifest, version, hash: hash(JSON.stringify(manifest)) };
}

/** The user helper is separate from the administrator-installed unlock service. */
export class WindowsRemoteHelperApp {
  constructor({ sourcePath = bundledWindowsHelperPath(), installDir = windowsHelperInstallDirectory(), processes = windowsHelperProcesses, stopProcesses = stopWindowsHelperProcesses, acquireLock = acquireWindowsInstallLock, lockTimeoutMs = 10000 } = {}) {
    Object.assign(this, { sourcePath, installDir, processes, stopProcesses, acquireLock, lockTimeoutMs });
    this.executable = join(installDir, WINDOWS_HELPER_EXECUTABLE);
  }
  async available() { try { await access(this.sourcePath); return true; } catch { return false; } }
  async describe() {
    const installed = await readPayload(this.installDir, true), source = await readPayload(dirname(this.sourcePath));
    return { name: 'AgentRoam Remote Desktop', path: this.executable, version: installed?.version ?? source?.version ?? 'unknown', fingerprint: (installed ?? source)?.hash.slice(0, 12), installed: Boolean(installed), updatePending: false };
  }
  prepare() { return this.withPreparedApp(path => path); }
  async withPreparedApp(use) {
    const parent = dirname(this.installDir);
    await mkdir(parent, { recursive: true });
    const unlock = await this.acquireLock(this.installDir, this.lockTimeoutMs);
    try {
      const backup = join(parent, '.RemoteDesktop.previous');
      let installed = await readPayload(this.installDir, true);
      const previous = await readPayload(backup, true);
      if (previous) {
        if (!installed) { await rename(backup, this.installDir); installed = previous; }
        else await rm(backup, { recursive: true });
      }
      const source = await readPayload(dirname(this.sourcePath));
      if (!source) throw new Error('当前 CLI 未包含 Windows 远程桌面组件，请升级 CLI');
      const keepInstalled = installed && (installed.hash === source.hash || installed.version !== 'legacy' && compareComponentVersions(installed.version, source.version) >= 0);
      const targetVersion = keepInstalled ? installed.version : source.version;
      const running = await this.processes();
      const retired = [];
      for (const item of running.filter(item => canonical(item.path) !== canonical(this.executable))) {
        const directory = dirname(item.path);
        if (canonical(item.path) === canonical(this.sourcePath)) { retired.push({ ...item, directory, remove: false }); continue; }
        // Old npm runtime payloads can be identified without touching their
        // gateway, sessions or separately installed privileged unlock service.
        const packagePath = join(directory, '../../package.json');
        const pkg = JSON.parse(await readFile(packagePath, 'utf8').catch(() => { throw new Error('无法确认旧远控组件归属，未退出该进程'); }));
        if (pkg.name !== 'agentroam-runtime-win32-x64' || !canonical(directory).endsWith('\\runtime\\native') || !componentVersionPattern.test(pkg.version)) throw new Error('无法确认旧远控组件归属，未退出该进程');
        const payload = await readPayload(directory);
        if (compareComponentVersions(payload.version === 'legacy' ? pkg.version : payload.version, targetVersion) > 0) throw new Error('检测到较新的远控组件，请使用最新 CLI 更新');
        retired.push({ ...item, directory, remove: canonical(directory) !== canonical(dirname(this.sourcePath)), hash: payload.hash });
      }
      const stop = [...retired, ...(!keepInstalled ? running.filter(item => canonical(item.path) === canonical(this.executable)) : [])];
      const retire = async () => {
        await this.stopProcesses(stop.map(({ pid, path }) => ({ pid, path })));
      };
      const cleanup = async () => {
        for (const item of new Map(retired.filter(item => item.remove).map(item => [canonical(item.directory), item])).values()) {
          if ((await readPayload(item.directory))?.hash !== item.hash) throw new Error('旧远控组件已变化，未删除');
          await rm(item.path);
          await rm(join(item.directory, WINDOWS_HELPER_METADATA), { force: true });
        }
      };
      if (keepInstalled) {
        await retire(); await cleanup();
        return await use(this.executable);
      }
      const staging = await mkdtemp(join(parent, '.remote-helper-update-'));
      const staged = join(staging, 'RemoteDesktop');
      let moved = false;
      try {
        await mkdir(staged);
        for (const name of payloadFiles) await copyFile(join(dirname(this.sourcePath), name), join(staged, name));
        await writeFile(join(staged, WINDOWS_HELPER_METADATA), JSON.stringify(source.manifest) + '\n');
        if ((await readPayload(staged, true))?.hash !== source.hash) throw new Error('远控组件复制校验失败');
        await retire();
        if (installed) { await rename(this.installDir, backup); moved = true; }
        try { await rename(staged, this.installDir); }
        catch (error) {
          if (moved) {
            try { await rename(backup, this.installDir); }
            catch { throw new Error(`远控组件更新失败，旧组件保留在 ${backup}`); }
          }
          throw error;
        }
        if (moved) await rm(backup, { recursive: true });
        await cleanup();
      } finally { await rm(staging, { recursive: true, force: true }); }
      return await use(this.executable);
    } finally { await unlock(); }
  }
}
