#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { MINIMUM_NODE_VERSION } from "../packages/cli/bin/runtime-policy.mjs";

if (!process.argv[2]) throw new Error("usage: audit-cli-tarball.mjs <package.tgz>");

const tarball = resolve(process.argv[2]);
const list = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n");
const packageJson = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));

if (packageJson.name !== "agentroam") throw new Error(`unexpected package name: ${packageJson.name}`);
if (packageJson.engines?.node !== `>=${MINIMUM_NODE_VERSION}`) throw new Error("launcher Node.js engines mismatch");
if (packageJson.os || packageJson.cpu) throw new Error("the agentroam launcher must not be platform-gated");
if (packageJson.bin?.agentroam !== "./bin/agentroam.mjs" || packageJson.bin?.["agent-tui"] !== "./bin/agent-tui.mjs") {
  throw new Error(`unexpected package bin: ${JSON.stringify(packageJson.bin)}`);
}
for (const dependency of [
  "agentroam-runtime-darwin-arm64",
  "agentroam-runtime-win32-x64",
  "agentroam-cloudflared-darwin-arm64",
  "agentroam-cloudflared-win32-x64",
  "agentroam-tui-darwin-arm64",
  "@caoqu/agentroam-tui-win32-x64",
]) {
  if (packageJson.optionalDependencies?.[dependency] !== packageJson.version) {
    throw new Error(`unexpected optional dependency ${dependency}: ${packageJson.optionalDependencies?.[dependency]}`);
  }
}
if (statSync(tarball).size >= 5_000_000) throw new Error(`launcher tarball exceeds 5 MB release limit: ${statSync(tarball).size}`);
if (basename(tarball) !== `${packageJson.name}-${packageJson.version}.tgz`) throw new Error("launcher tarball filename mismatch");

const allowed = ["package/package.json", "package/README.md", "package/bin/", "package/dist/", "package/install/"];
const unexpected = list.filter((file) => !allowed.some((entry) => file === entry || (entry.endsWith("/") && file.startsWith(entry))));
if (unexpected.length) throw new Error(`unexpected launcher files:\n${unexpected.slice(0, 50).join("\n")}`);

const forbidden = [
  /\.env(?:\.|$)/,
  /\.sessions\//,
  /agent\.db/,
  /\.node$/,
  /package\/runtime\//,
  /package\/runtimes\//,
  /node-v\d+.*\.(?:zip|tar\.(?:xz|gz))$/,
  /\.git\//,
];
const hits = list.filter((file) => forbidden.some((pattern) => pattern.test(file)));
if (hits.length) throw new Error(`forbidden launcher files:\n${hits.join("\n")}`);

for (const required of [
  "package/bin/agentroam.mjs",
  "package/bin/agent-tui.mjs",
  "package/bin/node-preflight.mjs",
  "package/bin/runtime-policy.mjs",
  "package/bin/node-runtime-policy.json",
  "package/dist/cli.js",
  "package/dist/node-runtime-manager.js",
  "package/dist/platform.js",
  "package/dist/platform-packages.js",
  "package/dist/power/sleep-inhibitor.js",
  "package/dist/cloudflared/bundled-asset.js",
  "package/dist/cloudflared/installer.js",
  "package/dist/service/macos-launch-agent.js",
  "package/dist/service/runtime-state.js",
  "package/dist/service/service-controller.js",
  "package/dist/service/service-command.js",
  "package/dist/service/service-files.js",
  "package/dist/service/windows-service-host.js",
  "package/dist/service/windows-task-service.js",
  "package/dist/tunnel/relay-orchestrator.js",
  "package/install/install-agentroam.sh",
  "package/install/install-agentroam.ps1",
  "package/install/README.md",
]) {
  if (!list.includes(required)) throw new Error(`missing launcher file: ${required}`);
}

console.log(`launcher tarball audit passed: ${packageJson.name}@${packageJson.version}, ${list.length} entries`);
