import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(root, 'packages/server/native/remote-helper-windows');
const build = resolve(root, 'packages/server/native/.build-remote/windows');
const desktopOutput = resolve(process.env.AGENT_WINDOWS_REMOTE_HELPER_OUTPUT || resolve(build, 'agentroam-remote-desktop.exe'));
// The unlock service ships next to the desktop helper and shares the build dir.
const unlockOutput = resolve(dirname(desktopOutput), 'agentroam-remote-unlock.exe');
const include = resolve(build, 'include/nlohmann');
await mkdir(include, { recursive: true });
await mkdir(resolve(desktopOutput, '..'), { recursive: true });
const header = resolve(include, 'json.hpp');
const expected = '9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6';
let bytes;
try { bytes = await readFile(header); } catch {}
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
  const response = await fetch('https://raw.githubusercontent.com/nlohmann/json/v3.11.3/single_include/nlohmann/json.hpp', { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`JSON dependency download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('JSON header hash mismatch');
  await writeFile(header, bytes);
}
const targets = [
  { files: ['main.cpp', 'capture.cpp', 'video.cpp', 'input.cpp', 'power.cpp'], output: desktopOutput, libraries: ['d3d11', 'dxgi', 'windowscodecs', 'mfplat', 'mf', 'mfuuid', 'wmcodecdspuuid', 'ole32', 'oleaut32', 'uuid', 'user32', 'gdi32', 'wtsapi32', 'strmiids'] },
  { files: ['unlock-service.cpp'], output: unlockOutput, libraries: ['user32', 'advapi32', 'wtsapi32'] },
];
const compiler = process.env.AGENT_WINDOWS_CXX || (process.platform === 'win32' ? 'cl.exe' : 'x86_64-w64-mingw32-g++');
for (const target of targets) {
  const args = process.platform === 'win32' && /(?:^|[/\\])cl(?:\.exe)?$/i.test(compiler)
    ? ['/nologo', '/std:c++17', '/EHsc', '/O2', '/MT', '/utf-8', '/D_WIN32_WINNT=0x0A00', `/I${resolve(include, '..')}`, ...target.files.map(name => resolve(source, name)), `/Fe:${target.output}`, '/link', '/Brepro', ...target.libraries.map(name => `${name}.lib`)]
    : ['-std=c++17', '-O2', '-Wall', '-Wextra', '-s', '-Wl,--no-insert-timestamp', '-static', '-static-libgcc', '-static-libstdc++', '-D_WIN32_WINNT=0x0A00', '-I', resolve(include, '..'), ...target.files.map(name => resolve(source, name)), '-o', target.output, ...target.libraries.map(name => `-l${name}`)];
  execFileSync(compiler, args, { cwd: build, stdio: 'inherit' });
  const pe = await readFile(target.output);
  const peOffset = pe.readUInt32LE(0x3c);
  if (pe.toString('ascii', 0, 2) !== 'MZ' || pe.readUInt32LE(peOffset) !== 0x4550 || pe.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error(`Expected Windows x64 PE helper: ${target.output}`);
}
await copyFile(resolve(source, 'THIRD-PARTY-NOTICES.txt'), resolve(desktopOutput, '../remote-helper-NOTICES.txt'));
if (process.platform === 'win32') for (const target of targets) execFileSync(target.output, ['--self-test'], { stdio: 'inherit' });
console.log(`Windows remote helpers: ${desktopOutput}, ${unlockOutput}`);
