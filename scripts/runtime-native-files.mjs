export const RUNTIME_TARGETS = {
  "darwin-arm64": {
    packageDir: "runtime-darwin-arm64",
    npmPlatform: "darwin",
    npmArch: "arm64",
    nodePtyDir: "darwin-arm64",
    nativeFiles: [
      "native/AgentRoam Remote Desktop.app/Contents/MacOS/agentroam-remote-desktop",
      "node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
      "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    ],
  },
  "windows-amd64": {
    packageDir: "runtime-win32-x64",
    npmPlatform: "win32",
    npmArch: "x64",
    nodePtyDir: "win32-x64",
    nativeFiles: [
      "native/agentroam-remote-desktop.exe",
      "native/agentroam-remote-unlock.exe",
      "node_modules/better-sqlite3/prebuilds/win32-x64.node",
      "node_modules/node-pty/prebuilds/win32-x64/conpty.node",
      "node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node",
      "node_modules/node-pty/prebuilds/win32-x64/pty.node",
      "node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll",
      "node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe",
      "node_modules/node-pty/prebuilds/win32-x64/winpty-agent.exe",
      "node_modules/node-pty/prebuilds/win32-x64/winpty.dll",
    ],
  },
};

export function validateNativeInventory(manifest, entries) {
  const target = RUNTIME_TARGETS[manifest.target];
  if (!target) throw new Error(`unsupported runtime target: ${manifest.target}`);
  const inventory = manifest.nativeFiles;
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error("runtime manifest has no native file inventory");
  }
  for (const required of target.nativeFiles) {
    if (!Object.hasOwn(inventory, required)) throw new Error(`native inventory missing required file: ${required}`);
  }
  for (const [file, hash] of Object.entries(inventory)) {
    if (!target.nativeFiles.includes(file)) throw new Error(`unexpected native file: ${file}`);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`invalid native hash: ${file}`);
    if (!entries.includes(`package/runtime/${file}`)) throw new Error(`missing inventoried native file: ${file}`);
  }
}
