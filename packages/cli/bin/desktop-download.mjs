import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';

const RELEASE_BASE = 'https://gitee.com/caoqu/team-agent/releases/download';

export function desktopAsset(manifest, version, platform, arch) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/.test(version)) throw new Error('Invalid AgentRoam version');
  const target = platform === 'darwin' && arch === 'arm64' ? 'darwin-arm64' : platform === 'win32' && arch === 'x64' ? 'windows-amd64' : null;
  if (!target) throw new Error('Desktop download supports macOS Apple Silicon and Windows x64');
  const asset = manifest?.installers?.desktop?.[target];
  const expected = platform === 'darwin' ? `AgentRoam-${version}-arm64.dmg` : `AgentRoam-Setup-${version}-x64.exe`;
  if (manifest?.schemaVersion !== 2 || manifest.version !== version || manifest.channel !== (version.includes('-preview.') ? 'preview' : 'latest') || asset?.fileName !== expected || !/^[a-f0-9]{64}$/.test(asset?.sha256 ?? '') || asset.signed !== false || (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size <= 0))) {
    throw new Error('This release has no valid desktop installer for your platform');
  }
  return asset;
}

export async function downloadDesktop(version, { platform = process.platform, arch = process.arch, directory = join(homedir(), 'Downloads'), fetchImpl = fetch } = {}) {
  const launcher = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (version === launcher.version) version = launcher.optionalDependencies['agentroam-runtime-darwin-arm64'];
  // Validate coordinates before making any request.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/.test(version)) throw new Error('Invalid AgentRoam version');
  const response = await fetchImpl(`${RELEASE_BASE}/v${version}/release-manifest.json`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Desktop release manifest unavailable (${response.status})`);
  const asset = desktopAsset(await response.json(), version, platform, arch);
  await mkdir(directory, { recursive: true });
  // Unique directory prevents overwriting an existing installer, including concurrent downloads.
  const staging = await mkdtemp(join(directory, 'AgentRoam-'));
  const partial = join(staging, `${asset.fileName}.download`);
  try {
    const binary = await fetchImpl(`${RELEASE_BASE}/v${version}/${encodeURIComponent(asset.fileName)}`, { signal: AbortSignal.timeout(600_000) });
    if (!binary.ok || !binary.body) throw new Error(`Desktop download failed (${binary.status})`);
    const hash = createHash('sha256');
    let size = 0;
    const verifier = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
    await pipeline(Readable.fromWeb(binary.body), verifier, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
    if (hash.digest('hex') !== asset.sha256 || (asset.size !== undefined && asset.size !== size)) throw new Error('Desktop installer checksum or size mismatch');
    const destination = join(staging, asset.fileName);
    await rename(partial, destination);
    return destination;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const destination = await downloadDesktop(process.argv[2]);
    console.log(`桌面端安装包已下载：${destination}\n请打开安装包完成安装。首次打开 AgentRoam 后，按提示授权远程桌面。`);
    if (process.platform === 'darwin') execFile('/usr/bin/open', ['-R', destination], () => undefined);
    else if (process.platform === 'win32') execFile('explorer.exe', [`/select,${destination}`], () => undefined);
  } catch (error) {
    console.error(`桌面端下载未完成：${error.message}。CLI 已安装，可继续使用。`);
    process.exitCode = 1;
  }
}
