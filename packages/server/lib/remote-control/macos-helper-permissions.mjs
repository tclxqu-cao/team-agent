import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const services = new Map([['screen', 'ScreenCapture'], ['accessibility', 'Accessibility']]);
export const macRemoteBundleId = 'com.agentroam.remote-desktop';

async function designatedRequirement(app) {
  try {
    const { stdout, stderr } = await run('/usr/bin/codesign', ['-d', '-r-', app], { timeout: 5000 });
    return /^#?\s*designated => (.+)$/m.exec(stdout + '\n' + stderr)?.[1].trim();
  } catch { return undefined; }
}

// macOS uses the previous binary's designated requirement to recognize an
// update. A new CDHash alone is normal for a Developer ID signed upgrade.
export async function requiresNewMacGrant(previousApp, nextApp) {
  const requirement = await designatedRequirement(previousApp);
  if (!requirement) return false;
  try { await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', previousApp], { timeout: 10000 }); }
  catch { return false; }
  try {
    await run('/usr/bin/codesign', ['--verify', '-R', '=' + requirement, nextApp], { timeout: 5000 });
    return false;
  } catch (error) {
    // Exit 3 specifically means a verified signature did not meet the requirement.
    return error.code === 3;
  }
}

async function hasBuildSpecificIdentity(app) {
  return /^cdhash H"[0-9a-f]+"$/i.test(await designatedRequirement(app) ?? '');
}

async function resetService(service) {
  await run('/usr/bin/tccutil', ['reset', service, macRemoteBundleId], { timeout: 5000 });
}

/** Shared by all CLI and desktop runtimes, under the managed app's install lock. */
export class MacHelperPermissions {
  constructor(file, { requiresNewGrant = requiresNewMacGrant, buildSpecific = hasBuildSpecificIdentity, reset = resetService } = {}) {
    this.file = file;
    this.requiresNewGrant = requiresNewGrant;
    this.buildSpecific = buildSpecific;
    this.reset = reset;
  }

  async read() {
    try {
      const state = JSON.parse(await readFile(this.file, 'utf8'));
      return typeof state?.fingerprint === 'string' && Array.isArray(state.pending) ? state : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async save(fingerprint, pending, migration) {
    const temporary = this.file + '.' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify({ fingerprint, pending, migration }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }

  async trackInstallation(fingerprint, preexistingApp) {
    if ((await this.read())?.fingerprint === fingerprint) return;
    // Older installers have already discarded the previous signature. Admit a
    // legacy ad hoc install once, and only act if the user requests a missing grant.
    const migration = Boolean(preexistingApp && await this.buildSpecific(preexistingApp));
    await this.save(fingerprint, migration ? [...services.keys()] : [], migration);
  }

  async recordReplacement(previousApp, previousHash, nextApp, nextHash) {
    if (previousHash === nextHash) return;
    const state = await this.read();
    if (state?.fingerprint === nextHash && state.migration) return;
    if (await this.requiresNewGrant(previousApp, nextApp)) {
      await this.save(nextHash, [...services.keys()], true);
    } else if (state?.fingerprint === previousHash) {
      // A compatible second upgrade may happen before the user opens Settings.
      await this.save(nextHash, state.pending, state.migration);
    }
  }

  async hasPending(fingerprint, permission) {
    const state = await this.read();
    return Boolean(state && state.fingerprint === fingerprint && state.pending.includes(permission));
  }

  async beforePrompt(fingerprint, permission, probe) {
    const service = services.get(permission);
    if (!service) throw new Error('未知权限');
    const state = await this.read();
    if (!state || state.fingerprint !== fingerprint || !state.pending.includes(permission)) return false;
    const status = await probe();
    if (status.locked !== false || typeof status[permission] !== 'boolean') return false;
    const missing = !status[permission];
    if (missing) {
      try { await this.reset(service); }
      catch (error) {
        console.warn('远控旧权限清理失败，将继续请求系统授权', { service, code: error.code });
        return false;
      }
    }
    // Consume each migration once, even if the new prompt is dismissed. Also
    // retire permissions the currently running binary already demonstrably has.
    await this.save(fingerprint, state.pending.filter(key => key !== permission && status[key] !== true), state.migration);
    return missing;
  }
}
