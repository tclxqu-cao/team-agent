import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = resolve(root, "packages/server");
const core = resolve(root, "packages/core");
const target = resolve(root, "packages/cli/runtime");

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

const serverPkg = JSON.parse(await readFile(resolve(server, "package.json"), "utf8"));
const {
  "@agent/core": _core,
  "@xterm/addon-fit": _xtermFit,
  "@xterm/xterm": _xterm,
  ...runtimeDeps
} = serverPkg.dependencies;
const runtimePkg = {
  name: "@agent/server-runtime",
  private: true,
  type: "module",
  dependencies: runtimeDeps,
};
await writeFile(resolve(target, "package.json"), `${JSON.stringify(runtimePkg, null, 2)}\n`);

execFileSync("npm", ["install", "--omit=dev", "--omit=optional", "--no-audit", "--no-fund"], {
  cwd: target,
  stdio: "inherit",
});

const nodePtyPrebuilds = resolve(target, "node_modules/node-pty/prebuilds");
for (const platform of await readdir(nodePtyPrebuilds)) {
  if (platform !== "darwin-arm64") {
    await rm(resolve(nodePtyPrebuilds, platform), { recursive: true, force: true });
  }
}

const coreTarget = resolve(target, "node_modules/@agent/core");
await mkdir(coreTarget, { recursive: true });
await cp(resolve(core, "dist"), resolve(coreTarget, "dist"), { recursive: true });
await writeFile(
  resolve(coreTarget, "package.json"),
  `${JSON.stringify({ name: "@agent/core", version: "0.2.0", type: "module", main: "./dist/index.js", exports: "./dist/index.js" }, null, 2)}\n`,
);

// the web console's default 智能助手 tab serves @agent/webapp from /app
const webappDist = resolve(root, "packages/webapp/dist");
await mustExist(resolve(webappDist, "index.html"));
await cp(webappDist, resolve(target, "webapp", "dist"), { recursive: true });

const forbidden = [".env.local", ".sessions", "agent.db", "packages/desktop", "packages/sdk"];
for (const item of forbidden) {
  try {
    await stat(resolve(target, item));
    throw new Error(`forbidden runtime artifact: ${item}`);
  } catch (error) {
    if (error?.code !== "ENOENT" && String(error.message).startsWith("forbidden")) throw error;
  }
}

console.log(`staged CLI runtime at ${target}`);

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
