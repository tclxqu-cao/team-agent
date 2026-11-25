import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { compareComponentVersions } from '../../server/lib/remote-control/component-version.mjs';
import { MacRemoteHelperApp } from '../../server/lib/remote-control/macos-helper-app.mjs';
import { prepareMacRemoteComponent } from '../../server/lib/remote-control/helper-manager.mjs';
import { bundledRuntimePackages } from './bundled-runtime.mjs';

const execute = promisify(execFile);
const member = 'package/runtime/native/Support.noindex/AgentRoam Remote Desktop.app';

export async function prepareBundledMacRemoteComponent(directory, launcherVersion, runtimeVersion, permission,
  { managed = new MacRemoteHelperApp(), prepare = prepareMacRemoteComponent } = {}) {
  if (permission !== undefined && permission !== 'screen' && permission !== 'accessibility') throw new Error('未知权限');
  const installed = await managed.describe();
  if (installed.installed && compareComponentVersions(installed.version, runtimeVersion) >= 0) {
    if (permission) await prepare(managed.appPath, permission);
    return;
  }
  const [archive] = await bundledRuntimePackages(directory, 'darwin-arm64', launcherVersion, runtimeVersion, 'agentroam-runtime-darwin-arm64');
  const extraction = await mkdtemp(join(tmpdir(), 'agentroam-desktop-remote-'));
  try {
    await execute('/usr/bin/tar', ['-xzf', archive, '-C', extraction, member], { timeout: 60_000 });
    await prepare(join(extraction, member), permission);
  } finally { await rm(extraction, { recursive: true, force: true }); }
}
