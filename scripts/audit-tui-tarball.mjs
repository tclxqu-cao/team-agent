#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { MINIMUM_NODE_VERSION } from "../packages/cli/bin/runtime-policy.mjs";
import { basename, resolve } from "node:path";

if (!process.argv[2]) throw new Error("usage: audit-tui-tarball.mjs <package.tgz>");

const tarball = resolve(process.argv[2]);
const list = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
const packageJson = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
const expected = {
  "agentroam-tui-darwin-arm64": { os: ["darwin"], cpu: ["arm64"] },
  "@caoqu/agentroam-tui-win32-x64": { os: ["win32"], cpu: ["x64"] },
}[packageJson.name];

if (packageJson.engines?.node !== `>=${MINIMUM_NODE_VERSION}`) throw new Error("TUI Node.js engines mismatch");
if (packageJson.dependencies?.["better-sqlite3"] !== "13.0.3") throw new Error("TUI SQLite runtime dependency missing");
if (!expected) throw new Error(`unexpected TUI package name: ${packageJson.name}`);
if (packageJson.bin) throw new Error("platform TUI package must not shadow the agentroam bin shim");
if (packageJson.exports?.["./entry"] !== "./dist/agent-tui.js") throw new Error("TUI entry export missing");
if (JSON.stringify(packageJson.os) !== JSON.stringify(expected.os) || JSON.stringify(packageJson.cpu) !== JSON.stringify(expected.cpu)) {
  throw new Error(`unexpected TUI platform: ${JSON.stringify({ os: packageJson.os, cpu: packageJson.cpu })}`);
}
if (statSync(tarball).size >= 10_000_000) throw new Error(`TUI tarball exceeds 10 MB release limit: ${statSync(tarball).size}`);
const expectedFilename = `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`;
if (basename(tarball) !== expectedFilename) throw new Error("TUI tarball filename mismatch");

const allowed = ["package/package.json", "package/README.md", "package/dist/"];
const unexpected = list.filter((file) => !allowed.some((entry) => file === entry || (entry.endsWith("/") && file.startsWith(entry))));
if (unexpected.length) throw new Error(`unexpected TUI files:\n${unexpected.join("\n")}`);
if (!list.includes("package/dist/agent-tui.js")) throw new Error("missing TUI entry bundle");
if (list.some((file) => file.endsWith(".map") || file.endsWith(".d.ts") || file.includes("node_modules/"))) {
  throw new Error("TUI package contains build-only files");
}

console.log(`TUI tarball audit passed: ${packageJson.name}@${packageJson.version}, ${list.length} entries`);
