import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";

if (!process.argv[2]) throw new Error("usage: audit-tui-tarball.mjs <package.tgz>");

const tarball = resolve(process.argv[2]);
const list = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
const packageJson = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));

if (packageJson.name !== "agentroam-tui-darwin-arm64") throw new Error(`unexpected package name: ${packageJson.name}`);
if (packageJson.version !== "0.2.0-preview.6") throw new Error(`unexpected package version: ${packageJson.version}`);
if (packageJson.bin?.["agent-tui"] !== "./bin/agent-tui.mjs") throw new Error(`unexpected package bin: ${JSON.stringify(packageJson.bin)}`);
if (JSON.stringify(packageJson.os) !== JSON.stringify(["darwin"]) || JSON.stringify(packageJson.cpu) !== JSON.stringify(["arm64"])) {
  throw new Error(`unexpected platform: ${JSON.stringify({ os: packageJson.os, cpu: packageJson.cpu })}`);
}
if (statSync(tarball).size >= 10_000_000) throw new Error(`TUI tarball exceeds 10 MB release limit: ${statSync(tarball).size}`);
if (basename(tarball) !== `agentroam-tui-darwin-arm64-${packageJson.version}.tgz`) throw new Error("tarball filename mismatch");

const allowed = ["package/package.json", "package/README.md", "package/bin/", "package/dist/"];
const unexpected = list.filter((file) => !allowed.some((entry) => file === entry || (entry.endsWith("/") && file.startsWith(entry))));
if (unexpected.length) throw new Error(`unexpected TUI files:\n${unexpected.join("\n")}`);
for (const required of ["package/bin/agent-tui.mjs", "package/dist/agent-tui.js"]) {
  if (!list.includes(required)) throw new Error(`missing TUI file: ${required}`);
}
if (list.some((file) => file.endsWith(".map") || file.endsWith(".d.ts") || file.includes("node_modules/"))) {
  throw new Error("TUI package contains build-only files");
}

console.log(`tarball audit passed: ${packageJson.name}@${packageJson.version}, ${list.length} entries`);
