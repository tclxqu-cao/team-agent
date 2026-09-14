import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error Standalone bootstrap helper ships as JavaScript.
import { desktopAsset, downloadDesktop } from '../bin/desktop-download.mjs';

const version = '0.2.0-preview.17';
const body = Buffer.from('desktop test artifact');
function manifest() {
  return { schemaVersion: 2, version, channel: 'preview', installers: { desktop: {
    'darwin-arm64': { fileName: `AgentRoam-${version}-arm64.dmg`, sha256: createHash('sha256').update(body).digest('hex'), size: body.length, signed: false },
    'windows-amd64': { fileName: `AgentRoam-Setup-${version}-x64.exe`, sha256: createHash('sha256').update(body).digest('hex'), signed: false },
  } } };
}

describe('optional desktop installer download', () => {
  it('selects the versioned Windows asset and rejects wrong versions and filenames', () => {
    expect(desktopAsset(manifest(), version, 'win32', 'x64').fileName).toMatch(/\.exe$/);
    expect(() => desktopAsset(manifest(), '0.2.0-preview.18', 'darwin', 'arm64')).toThrow();
    const invalid = manifest(); invalid.installers.desktop['darwin-arm64'].fileName = '../unsafe.dmg';
    expect(() => desktopAsset(invalid, version, 'darwin', 'arm64')).toThrow();
  });
  it('downloads and verifies into unique directories without overwriting previous installs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-download-'));
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('.json') ? Response.json(manifest()) : new Response(body));
    try {
      const first = await downloadDesktop(version, { directory, platform: 'darwin', arch: 'arm64', fetchImpl });
      const second = await downloadDesktop(version, { directory, platform: 'darwin', arch: 'arm64', fetchImpl });
      expect(await readFile(first)).toEqual(body);
      expect(second).not.toBe(first);
      expect(fetchImpl.mock.calls[1][0]).toContain(`/v${version}/AgentRoam-${version}-arm64.dmg`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('cleans up partial files on checksum mismatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'desktop-download-'));
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('.json') ? Response.json(manifest()) : new Response('corrupted'));
    try {
      await expect(downloadDesktop(version, { directory, platform: 'darwin', arch: 'arm64', fetchImpl })).rejects.toThrow('checksum');
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects missing platform artifacts before downloading binaries', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ...manifest(), installers: {} }));
    await expect(downloadDesktop(version, { platform: 'darwin', arch: 'arm64', fetchImpl })).rejects.toThrow('no valid');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// Exercise the actual installer tail with an isolated launcher. Nothing installs
// on the machine; the helper records whether the optional branch ran.
describe.skipIf(process.platform === 'win32')('Shell desktop choice after CLI installation', () => {
  it.each(['no', 'yes', undefined])('handles choice %s without reading piped script input', async (choice) => {
    const { execFileSync } = await import('node:child_process');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'desktop-choice-'));
    try {
      const bin = join(root, 'node_modules/agentroam/bin');
      await mkdir(bin, { recursive: true });
      const marker = join(root, 'selected');
      await writeFile(join(bin, 'desktop-download.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CHOICE_MARKER, process.argv[2]);`);
      const installer = await readFile(new URL('../install/install-agentroam.sh', import.meta.url), 'utf8');
      const section = installer.slice(installer.indexOf('# stdin is the script itself'));
      const env: NodeJS.ProcessEnv = { ...process.env, LAUNCHER_ROOT: root, NODE_BIN: process.execPath, AGENTROAM_VERSION: version, CHOICE_MARKER: marker };
      delete env.AGENTROAM_INSTALL_DESKTOP;
      if (choice) Object.assign(env, { AGENTROAM_INSTALL_DESKTOP: choice });
      execFileSync('/bin/sh', ['-c', section], { env, input: 'yes\n' });
      if (choice === 'yes') expect(await readFile(marker, 'utf8')).toBe(version);
      else expect(await readdir(root)).not.toContain('selected');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
