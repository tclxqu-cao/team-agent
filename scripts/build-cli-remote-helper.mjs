import { readFile, mkdir, writeFile, copyFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build the macOS remote helper on Apple Silicon');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(process.env.AGENT_REMOTE_HELPER_OUTPUT || resolve(root, 'packages/server/native/AgentRoam Remote Desktop.app'));
const build = resolve(root, 'packages/server/native/.build-remote');
await mkdir(build, { recursive: true });
await mkdir(resolve(output, 'Contents/MacOS'), { recursive: true });
const existing = await readFile(resolve(root, 'packages/desktop/native/desktop-input.swift'), 'utf8');
const marker = '// Dispatch-driven stdin loop';
if (!existing.includes(marker)) throw new Error('Desktop input source contract changed');
await writeFile(resolve(build, 'main.swift'), existing.split(marker)[0] + '\n' + await readFile(resolve(root, 'packages/server/native/remote-helper/main.swift'), 'utf8'));
const service = resolve(root, 'packages/server/native/remote-helper/service');
// Some Command Line Tools installs keep a stale usr/include/swift/module.modulemap
// next to the current bridging.modulemap; both define SwiftBridging, so every
// swiftc run fails with "redefinition of module 'SwiftBridging'". swift-frontend
// derives its toolchain include directory from its own binary location, so run a
// copied frontend from a shadow toolchain whose include directory keeps only the
// current module map. Delete the stale CLT file to retire this workaround.
const cltRoot = '/Library/Developer/CommandLineTools';
const cltSwiftDir = resolve(cltRoot, 'usr/include/swift');
let swiftcCommand = null;
{
  const moduleMapPattern = /module\s+SwiftBridging\s*\{/;
  const [stale, current] = await Promise.all([
    readFile(resolve(cltSwiftDir, 'module.modulemap'), 'utf8').catch(() => null),
    readFile(resolve(cltSwiftDir, 'bridging.modulemap'), 'utf8').catch(() => null),
  ]);
  if (stale && current && moduleMapPattern.test(stale) && moduleMapPattern.test(current)) {
    const shadow = resolve(build, 'swift-toolchain');
    const shadowBin = resolve(shadow, 'usr/bin');
    await mkdir(shadowBin, { recursive: true });
    await mkdir(resolve(shadow, 'usr/include/swift'), { recursive: true });
    await mkdir(resolve(shadow, 'usr/lib'), { recursive: true });
    await copyFile(resolve(cltRoot, 'usr/bin/swift-frontend'), resolve(shadowBin, 'swift-frontend'));
    for (const name of ['swiftc', 'clang', 'clang++']) {
      await (name === 'swiftc'
        ? copyFile(resolve(cltRoot, 'usr/bin/swift-frontend'), resolve(shadowBin, 'swiftc'))
        : symlink(resolve(cltRoot, `usr/bin/${name}`), resolve(shadowBin, name)).catch((error) => {
            if (error.code !== 'EEXIST') throw error;
          }));
    }
    await symlink(resolve(cltRoot, 'usr/lib/swift'), resolve(shadow, 'usr/lib/swift')).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    for (const name of ['bridging.modulemap', 'bridging']) {
      await symlink(resolve(cltSwiftDir, name), resolve(shadow, `usr/include/swift/${name}`)).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    swiftcCommand = resolve(shadowBin, 'swiftc');
  }
}
const sdkPath = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
execFileSync('xcrun', ['clang', '-fobjc-arc', '-target', 'arm64-apple-macos14.0', '-c', resolve(service, 'QuartzBridge.m'), '-o', resolve(build, 'QuartzBridge.o')], { stdio: 'inherit' });
await mkdir(resolve(output, 'Contents/Resources'), { recursive: true });
await copyFile(resolve(root, 'packages/desktop/assets/app-icon.icns'), resolve(output, 'Contents/Resources/app-icon.icns'));
const swiftArgs = ['-import-objc-header', resolve(service, 'QuartzBridge.h'), resolve(build, 'QuartzBridge.o'), resolve(service, 'Input.swift'), resolve(service, 'Capture.swift'), resolve(service, 'Service.swift'), resolve(service, 'VideoEncoder.swift'), '-swift-version', '5', '-O', '-target', 'arm64-apple-macos14.0', '-o', resolve(output, 'Contents/MacOS/agentroam-remote-desktop'), resolve(build, 'main.swift')];
if (swiftcCommand) execFileSync(swiftcCommand, ['-sdk', sdkPath, ...swiftArgs], { stdio: 'inherit' });
else execFileSync('xcrun', ['swiftc', ...swiftArgs], { stdio: 'inherit' });
await writeFile(resolve(output, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.agentroam.remote-desktop</string><key>CFBundleName</key><string>AgentRoam Remote Desktop</string><key>CFBundleDisplayName</key><string>AgentRoam Remote Desktop</string><key>CFBundleExecutable</key><string>agentroam-remote-desktop</string><key>CFBundleIconFile</key><string>app-icon.icns</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`);
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.agentroam.remote-desktop', output], { stdio: 'inherit' });
console.log(output);
