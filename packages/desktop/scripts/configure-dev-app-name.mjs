// macOS Dock uses the executable bundle's display name, not package.json's name.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url);
  const original = require('electron');
  const runtimeDir = fileURLToPath(new URL('../.runtime/', import.meta.url));
  mkdirSync(runtimeDir, { recursive: true });
  const appPath = join(runtimeDir, 'agentroam.app');
  if (!existsSync(appPath)) execFileSync('/bin/cp', ['-cR', resolve(dirname(original), '../..'), appPath]);
  const executable = join(appPath, 'Contents/MacOS/Electron');
  const plist = join(dirname(executable), '..', 'Info.plist');
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} agentroam`, plist]);
  }
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier com.agentroam.desktop.dev', plist]);
  copyFileSync(fileURLToPath(new URL('../assets/app-icon.icns', import.meta.url)), join(dirname(executable), '../Resources/agentroam.icns'));
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIconFile agentroam.icns', plist]);
  // A directly opened app must not fall back to Electron's default welcome page.
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  const bootstrapDir = join(appPath, 'Contents/Resources/app');
  mkdirSync(bootstrapDir, { recursive: true });
  writeFileSync(join(bootstrapDir, 'package.json'), JSON.stringify({ name: '@agent/desktop', main: 'index.cjs' }));
  writeFileSync(join(bootstrapDir, 'index.cjs'), [
    "const { app } = require('electron');",
    `app.setAppPath(${JSON.stringify(projectRoot)});`,
    "if (!process.env.VITE_PORT) process.env.NODE_ENV ??= 'production';",
    `import(${JSON.stringify(new URL('../dist/main/index.js', import.meta.url).href)}).catch(error => { console.error(error); app.quit(); });`,
  ].join('\n'));
  const bundle = resolve(dirname(executable), '../..');
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '-R=identifier com.agentroam.desktop.dev', bundle], { stdio: 'pipe' });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', bundle], { stdio: 'pipe' });
  } catch {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.agentroam.desktop.dev', '--preserve-metadata=entitlements,flags', bundle]);
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', bundle]);
  }
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle]);
  // Keep package.json name unchanged so Electron retains its existing user-data path.
}
