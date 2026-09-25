import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNativeTarget, sha256File } from "./native-binary.mjs";
import { MINIMUM_NODE_VERSION, assertSupportedNodeVersion } from "../packages/cli/bin/runtime-policy.mjs";
import { RUNTIME_TARGETS } from "./runtime-native-files.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = resolve(root, "packages/server");
const core = resolve(root, "packages/core");
const computerUse = resolve(root, "packages/computer-use");
const nativeRuntime = resolve(root, "packages/native-runtime");
const targetName = readRequiredOption("--target");
const nodeVersion = process.versions.node;
assertSupportedNodeVersion(nodeVersion);

const targetConfig = RUNTIME_TARGETS[targetName];
if (!targetConfig) throw new Error(`unsupported staging target: ${targetName}`);

const packageRoot = resolve(root, "packages", targetConfig.packageDir);
const target = resolve(packageRoot, "runtime");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

const buildRoot = resolve(server, process.env.NEXT_DIST_DIR || ".next");
const standaloneRoot = resolve(buildRoot, "standalone");
const nestedServer = resolve(standaloneRoot, "packages/server");
const standaloneServer = (await exists(resolve(nestedServer, "server.js"))) ? nestedServer : standaloneRoot;

const standaloneBuild = resolve(standaloneServer, basename(buildRoot));
await mustExist(resolve(standaloneBuild, "server"));
await cp(standaloneBuild, resolve(target, ".next"), { recursive: true });
await cp(resolve(standaloneServer, "server.js"), resolve(target, "server.js"));
await cp(resolve(buildRoot, "static"), resolve(target, ".next/static"), { recursive: true });
await cp(resolve(server, "ws-server.mjs"), resolve(target, "ws-server.mjs"));
await mkdir(resolve(target, "lib"), { recursive: true });
await mkdir(resolve(target, "lib/browser-live"), { recursive: true });
await cp(resolve(server, "lib/browser-live/viewer-frame-flow.mjs"), resolve(target, "lib/browser-live/viewer-frame-flow.mjs"));
await cp(resolve(server, "lib/remote-control"), resolve(target, "lib/remote-control"), { recursive: true, filter: (source) => !source.endsWith(".test.ts") });
if (targetName === "darwin-arm64") {
  // Local builds on machines with a broken CLT Swift toolchain can reuse the
  // helper from the previous published runtime (sources unchanged) by setting
  // AGENT_REUSE_REMOTE_HELPER=1 with the .app pre-placed in server/native/.
  if (!process.env.AGENT_REUSE_REMOTE_HELPER) {
    execFileSync(process.execPath, [resolve(root, "scripts/build-cli-remote-helper.mjs")], { stdio: "inherit" });
  }
  await cp(resolve(server, "native/AgentRoam Remote Desktop.app"), resolve(target, "native/AgentRoam Remote Desktop.app"), { recursive: true });
}
if (targetName === "windows-amd64") {
  execFileSync(process.execPath, [resolve(root, "scripts/build-windows-remote-helper.mjs")], { stdio: "inherit" });
  await mkdir(resolve(target, "native"), { recursive: true });
  const helper = resolve(process.env.AGENT_WINDOWS_REMOTE_HELPER_OUTPUT || resolve(server, "native/.build-remote/windows/agentroam-remote-desktop.exe"));
  await cp(helper, resolve(target, "native/agentroam-remote-desktop.exe"));
  await cp(resolve(helper, "../agentroam-remote-unlock.exe"), resolve(target, "native/agentroam-remote-unlock.exe"));
  await cp(resolve(server, "native/remote-helper-windows/THIRD-PARTY-NOTICES.txt"), resolve(target, "native/remote-helper-NOTICES.txt"));
}
await cp(resolve(server, "lib/desktop-discovery.mjs"), resolve(target, "lib/desktop-discovery.mjs"));
for (const name of ["device-pairing-store.mjs", "device-pairing-gateway.mjs", "pairing-page.mjs", "pwa-assets.mjs"]) {
  await cp(resolve(server, "lib", name), resolve(target, "lib", name));
}
await cp(resolve(server, "public/pwa"), resolve(target, "public/pwa"), { recursive: true });
await cp(resolve(server, "shell-integration.mjs"), resolve(target, "shell-integration.mjs"));
await cp(resolve(server, "shell-platform.mjs"), resolve(target, "shell-platform.mjs"));
await mkdir(resolve(target, "lib"), { recursive: true });
await mkdir(resolve(target, "lib/browser-live"), { recursive: true });
await cp(resolve(server, "lib/browser-live/viewer-frame-flow.mjs"), resolve(target, "lib/browser-live/viewer-frame-flow.mjs"));
await cp(resolve(server, "lib/file-preview-service.mjs"), resolve(target, "lib/file-preview-service.mjs"));
await cp(resolve(server, "lib/markdown-preview.mjs"), resolve(target, "lib/markdown-preview.mjs"));
await cp(resolve(server, "lib/ai-hub-relay-client.mjs"), resolve(target, "lib/ai-hub-relay-client.mjs"));

const serverPkg = JSON.parse(await readFile(resolve(server, "package.json"), "utf8"));
const {
  "@xterm/addon-fit": _xtermFit,
  "@xterm/xterm": _xterm,
  "lucide-react": _lucideReact,
  ...runtimeDeps
} = serverPkg.dependencies;
// Every @agent/* workspace package is copied from dist further down, so npm must
// never try to resolve one from the registry (it does not exist there).
for (const name of Object.keys(runtimeDeps)) {
  if (name.startsWith("@agent/")) delete runtimeDeps[name];
}
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
  npm_config_os: targetConfig.npmPlatform,
  npm_config_cpu: targetConfig.npmArch,
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

const sqlitePrebuilds = resolve(target, "node_modules/better-sqlite3/prebuilds");
for (const prebuild of await readdir(sqlitePrebuilds)) {
  if (prebuild !== `${targetConfig.npmPlatform}-${targetConfig.npmArch}.node`) {
    await rm(resolve(sqlitePrebuilds, prebuild), { recursive: true, force: true });
  }
}

// node-pty ships source/build dirs we never need at runtime.
await rm(resolve(target, "node_modules/node-pty/third_party"), { recursive: true, force: true });
await rm(resolve(target, "node_modules/node-pty/deps"), { recursive: true, force: true });
await rm(resolve(target, "node_modules/node-pty/src"), { recursive: true, force: true });

const nodePtyPrebuilds = resolve(target, "node_modules/node-pty/prebuilds");
for (const platform of await readdir(nodePtyPrebuilds)) {
  if (platform !== targetConfig.nodePtyDir) await rm(resolve(nodePtyPrebuilds, platform), { recursive: true, force: true });
}

// @agent/* are workspace symlinks; the packaged runtime needs real copies.
// Next keeps them external, so anything the server imports at runtime must be
// shipped here — missing one only shows up after release, never in dev.
for (const { dir, dist } of [
  { dir: core, dist: resolve(core, "dist") },
  { dir: computerUse, dist: resolve(computerUse, "dist") },
  { dir: nativeRuntime, dist: resolve(nativeRuntime, "dist") },
]) {
  const name = JSON.parse(await readFile(resolve(dir, "package.json"), "utf8")).name;
  const destination = resolve(target, "node_modules", name);
  await mkdir(destination, { recursive: true });
  await cp(dist, resolve(destination, "dist"), { recursive: true });
  await writeFile(
    resolve(destination, "package.json"),
    `${JSON.stringify({ name, version: "0.2.0", type: "module", main: "./dist/index.js", exports: "./dist/index.js" }, null, 2)}\n`,
  );
}

// The @agent dist copies above land after the first cleanup pass, so their
// emitted .map/.d.ts/.pdb files must be stripped here or they ship in the package.
await removeMatchingFiles(resolve(target, "node_modules"), (name) => name.endsWith(".map") || name.endsWith(".d.ts") || name.endsWith(".pdb"));

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
  schemaVersion: 2,
  minimumNodeVersion: MINIMUM_NODE_VERSION,
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
