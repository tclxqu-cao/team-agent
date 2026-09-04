#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { assertNativeTarget, sha256File } from "./native-binary.mjs";

if (!process.argv[2]) throw new Error("usage: audit-runtime-tarball.mjs <package.tgz>");

const tarball = resolve(process.argv[2]);
const list = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim().split("\n");
const packageJson = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/manifest.json"], { encoding: "utf8" }));
const expected = {
  "darwin-arm64": { name: "agentroam-runtime-darwin-arm64", os: ["darwin"], cpu: ["arm64"], pty: "darwin-arm64" },
  "windows-amd64": { name: "agentroam-runtime-win32-x64", os: ["win32"], cpu: ["x64"], pty: "win32-x64" },
}[manifest.target];

if (!expected) throw new Error(`unexpected runtime target: ${manifest.target}`);
if (packageJson.name !== expected.name) throw new Error(`unexpected runtime package name: ${packageJson.name}`);
if (packageJson.version !== manifest.packageVersion) throw new Error(`runtime package/manifest version mismatch: ${packageJson.version}`);
if (JSON.stringify(packageJson.os) !== JSON.stringify(expected.os) || JSON.stringify(packageJson.cpu) !== JSON.stringify(expected.cpu)) {
  throw new Error(`unexpected runtime platform: ${JSON.stringify({ os: packageJson.os, cpu: packageJson.cpu })}`);
}
if (manifest.nodeMajor !== 22 || manifest.nodeModuleAbi !== 127) throw new Error("runtime must target Node 22 ABI 127");
if (basename(tarball) !== `${packageJson.name}-${packageJson.version}.tgz`) throw new Error("runtime tarball filename mismatch");
if (statSync(tarball).size >= 30_000_000) throw new Error(`runtime package exceeds 30 MB release limit: ${statSync(tarball).size}`);

const allowed = ["package/package.json", "package/README.md", "package/manifest.json", "package/runtime/"];
const unexpected = list.filter((file) => !allowed.some((entry) => file === entry || (entry.endsWith("/") && file.startsWith(entry))));
if (unexpected.length) throw new Error(`unexpected runtime files:\n${unexpected.slice(0, 50).join("\n")}`);

for (const required of [
  "package/runtime/package.json",
  "package/runtime/ws-server.mjs",
  "package/runtime/lib/file-preview-service.mjs",
  "package/runtime/.next/BUILD_ID",
  "package/runtime/node_modules/node-pty/package.json",
  "package/runtime/node_modules/better-sqlite3/package.json",
]) {
  if (!list.includes(required)) throw new Error(`missing runtime file: ${required}`);
}

const platformLeaks = list.filter((file) => {
  if (file.startsWith("package/runtime/node_modules/@next/swc-")) return true;
  const match = file.match(/^package\/runtime\/node_modules\/node-pty\/prebuilds\/([^/]+)\//);
  return Boolean(match && match[1] !== expected.pty);
});
if (platformLeaks.length) throw new Error(`unexpected cross-platform runtime files:\n${platformLeaks.slice(0, 50).join("\n")}`);

const nativeEntries = Object.entries(manifest.nativeFiles || {});
if (nativeEntries.length < 3) throw new Error("runtime manifest has no native file inventory");
for (const [path, hash] of nativeEntries) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`invalid native hash: ${path}`);
  if (!list.includes(`package/runtime/${path}`)) throw new Error(`missing inventoried native file: ${path}`);
}

const auditDir = mkdtempSync(join(tmpdir(), "agentroam-runtime-audit-"));
try {
  const archiveEntries = nativeEntries.map(([path]) => `package/runtime/${path}`);
  execFileSync("tar", ["-xzf", tarball, "-C", auditDir, ...archiveEntries]);
  for (const [path, expectedHash] of nativeEntries) {
    const extracted = join(auditDir, "package/runtime", path);
    const actualHash = await sha256File(extracted);
    if (actualHash !== expectedHash) throw new Error(`native file hash mismatch: ${path}`);
    await assertNativeTarget(extracted, manifest.target);
  }
} finally {
  rmSync(auditDir, { recursive: true, force: true });
}

console.log(`runtime tarball audit passed: ${packageJson.name}@${packageJson.version}, ${list.length} entries`);
