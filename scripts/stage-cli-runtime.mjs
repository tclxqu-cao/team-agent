import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNativeTarget, sha256File } from "./native-binary.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = resolve(root, "packages/server");
const core = resolve(root, "packages/core");
const targetName = readRequiredOption("--target");
const nodeVersion = process.versions.node;
const nodeMajor = Number(nodeVersion.split(".")[0]);
const nodeModuleAbi = Number(process.versions.modules);

if (nodeMajor !== 22 || nodeModuleAbi !== 127) {
  throw new Error(`Node.js 22 ABI 127 required for runtime staging (current ${nodeVersion}, ABI ${nodeModuleAbi})`);
}

const targets = {
  "darwin-arm64": {
    packageDir: "runtime-darwin-arm64",
    npmPlatform: "darwin",
    npmArch: "arm64",
    nodePtyDir: "darwin-arm64",
    nativeFiles: [
      "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
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
      "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
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

const targetConfig = targets[targetName];
if (!targetConfig) throw new Error(`unsupported staging target: ${targetName}`);

const packageRoot = resolve(root, "packages", targetConfig.packageDir);
const target = resolve(packageRoot, "runtime");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

const standaloneRoot = resolve(server, ".next/standalone");
const nestedServer = resolve(standaloneRoot, "packages/server");
const standaloneServer = (await exists(resolve(nestedServer, "server.js"))) ? nestedServer : standaloneRoot;

await mustExist(resolve(standaloneServer, ".next/server"));
await cp(resolve(standaloneServer, ".next"), resolve(target, ".next"), { recursive: true });
await cp(resolve(standaloneServer, "server.js"), resolve(target, "server.js"));
await cp(resolve(server, ".next/static"), resolve(target, ".next/static"), { recursive: true });
await cp(resolve(server, "ws-server.mjs"), resolve(target, "ws-server.mjs"));
await cp(resolve(server, "shell-integration.mjs"), resolve(target, "shell-integration.mjs"));
await cp(resolve(server, "shell-platform.mjs"), resolve(target, "shell-platform.mjs"));
await mkdir(resolve(target, "lib"), { recursive: true });
await cp(resolve(server, "lib/file-preview-service.mjs"), resolve(target, "lib/file-preview-service.mjs"));

const serverPkg = JSON.parse(await readFile(resolve(server, "package.json"), "utf8"));
const {
  "@agent/core": _core,
  "@xterm/addon-fit": _xtermFit,
  "@xterm/xterm": _xterm,
  "lucide-react": _lucideReact,
  ...runtimeDeps
} = serverPkg.dependencies;
const runtimePkg = {
  name: "@agent/server-runtime",
  private: true,
  type: "module",
  dependencies: {
    ...runtimeDeps,
    ajv: "^8.17.1",
    "ajv-formats": "^3.0.1",
  },
};
await writeFile(resolve(target, "package.json"), `${JSON.stringify(runtimePkg, null, 2)}\n`);

const installEnv = {
  ...process.env,
  npm_config_platform: targetConfig.npmPlatform,
  npm_config_arch: targetConfig.npmArch,
  npm_config_target: nodeVersion,
  npm_config_runtime: "node",
  npm_config_fallback_to_build: "false",
};
execFileSync("npm", [
  "install",
  "--ignore-scripts",
  "--omit=dev",
  "--omit=optional",
  "--omit=peer",
  "--no-audit",
  "--no-fund",
  "--workspaces=false",
], { cwd: target, stdio: "inherit", env: installEnv });

const prebuildInstall = resolve(target, "node_modules/prebuild-install/bin.js");
await mustExist(prebuildInstall);
execFileSync(process.execPath, [prebuildInstall], {
  cwd: resolve(target, "node_modules/better-sqlite3"),
  stdio: "inherit",
  env: installEnv,
});

await removeMatchingFiles(resolve(target, "node_modules"), (name) => name.endsWith(".map") || name.endsWith(".d.ts") || name.endsWith(".pdb"));
await rm(resolve(target, "node_modules/node-pty/third_party"), { recursive: true, force: true });
await rm(resolve(target, "node_modules/node-pty/deps"), { recursive: true, force: true });
await rm(resolve(target, "node_modules/node-pty/src"), { recursive: true, force: true });

const nodePtyPrebuilds = resolve(target, "node_modules/node-pty/prebuilds");
for (const platform of await readdir(nodePtyPrebuilds)) {
  if (platform !== targetConfig.nodePtyDir) await rm(resolve(nodePtyPrebuilds, platform), { recursive: true, force: true });
}

const coreTarget = resolve(target, "node_modules/@agent/core");
await mkdir(coreTarget, { recursive: true });
await cp(resolve(core, "dist"), resolve(coreTarget, "dist"), { recursive: true });
await writeFile(
  resolve(coreTarget, "package.json"),
  `${JSON.stringify({ name: "@agent/core", version: "0.2.0", type: "module", main: "./dist/index.js", exports: "./dist/index.js" }, null, 2)}\n`,
);

const webappDist = resolve(root, "packages/webapp/dist");
await mustExist(resolve(webappDist, "index.html"));
await cp(webappDist, resolve(target, "webapp", "dist"), { recursive: true });

for (const item of [".env.local", ".sessions", "agent.db", "packages/desktop", "packages/sdk"]) {
  if (await exists(resolve(target, item))) throw new Error(`forbidden runtime artifact: ${item}`);
}

const nativeFiles = {};
for (const nativeRelativePath of targetConfig.nativeFiles) {
  const nativePath = resolve(target, nativeRelativePath);
  await mustExist(nativePath);
  await assertNativeTarget(nativePath, targetName);
  nativeFiles[nativeRelativePath] = await sha256File(nativePath);
}

const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const manifest = {
  packageVersion: packageJson.version,
  target: targetName,
  nodeMajor,
  nodeModuleAbi,
  nativeFiles,
};
await writeFile(resolve(packageRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`staged ${targetName} CLI runtime at ${target}`);

function readRequiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : "";
  if (!value || value.startsWith("--")) throw new Error(`missing required ${name}`);
  return value;
}

async function mustExist(path) {
  await stat(path);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function removeMatchingFiles(directory, matches) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await removeMatchingFiles(path, matches);
    else if (matches(entry.name)) await rm(path, { force: true });
  }
}
