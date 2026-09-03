#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { assertNativeTarget, sha256File } from "./native-binary.mjs";

if (!process.argv[2]) throw new Error("usage: audit-cloudflared-tarball.mjs <package.tgz>");

const tarball = resolve(process.argv[2]);
const list = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
const packageJson = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/manifest.json"], { encoding: "utf8" }));
const expected = {
  "darwin-arm64": { name: "agentroam-cloudflared-darwin-arm64", os: ["darwin"], cpu: ["arm64"], format: "tgz" },
  "windows-amd64": { name: "agentroam-cloudflared-win32-x64", os: ["win32"], cpu: ["x64"], format: "executable" },
}[manifest.target];

if (!expected) throw new Error(`unexpected cloudflared target: ${manifest.target}`);
if (packageJson.name !== expected.name) throw new Error(`unexpected package name: ${packageJson.name}`);
if (packageJson.version !== manifest.packageVersion) throw new Error(`package/manifest version mismatch: ${packageJson.version}`);
if (JSON.stringify(packageJson.os) !== JSON.stringify(expected.os)) throw new Error(`unexpected package os: ${JSON.stringify(packageJson.os)}`);
if (JSON.stringify(packageJson.cpu) !== JSON.stringify(expected.cpu)) throw new Error(`unexpected package cpu: ${JSON.stringify(packageJson.cpu)}`);
if (manifest.assetFormat !== expected.format) throw new Error(`unexpected cloudflared format: ${manifest.assetFormat}`);
if (manifest.upstreamVersion !== "2026.8.2") throw new Error(`unexpected cloudflared version: ${manifest.upstreamVersion}`);
if (typeof manifest.size !== "number" || !Number.isSafeInteger(manifest.size) || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
  throw new Error("invalid cloudflared size or SHA-256");
}
const assetEntry = `package/vendor/${manifest.archiveFileName}`;
if (packageJson.exports?.["./archive"] !== `./vendor/${manifest.archiveFileName}`) throw new Error("cloudflared archive export mismatch");
if (packageJson.exports?.["./manifest.json"] !== "./manifest.json") throw new Error("cloudflared manifest export missing");
if (basename(tarball) !== `${packageJson.name}-${packageJson.version}.tgz`) throw new Error("cloudflared tarball filename mismatch");
if (statSync(tarball).size >= 30_000_000) throw new Error(`cloudflared package exceeds 30 MB release limit: ${statSync(tarball).size}`);

const allowed = new Set(["package/package.json", "package/README.md", "package/manifest.json", assetEntry]);
const unexpected = list.filter((file) => !allowed.has(file));
if (unexpected.length) throw new Error(`unexpected cloudflared package files:\n${unexpected.join("\n")}`);
if (!list.includes(assetEntry)) throw new Error(`missing cloudflared asset: ${assetEntry}`);

const auditDir = mkdtempSync(join(tmpdir(), "agentroam-cloudflared-audit-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", auditDir, assetEntry]);
  const asset = join(auditDir, assetEntry);
  const info = await stat(asset);
  const actualHash = await sha256File(asset);
  if (info.size !== manifest.size) throw new Error(`nested asset size mismatch: ${info.size}`);
  if (actualHash !== manifest.sha256) throw new Error(`nested asset SHA-256 mismatch: ${actualHash}`);
  if (manifest.assetFormat === "tgz") {
    const nested = execFileSync("tar", ["-tzf", asset], { encoding: "utf8" }).trim().split("\n");
    if (nested.length !== 1 || nested[0].replace(/^\.\//, "") !== manifest.fileName) {
      throw new Error(`unexpected upstream archive entries: ${nested.join(", ")}`);
    }
  } else {
    await assertNativeTarget(asset, manifest.target);
  }
} finally {
  rmSync(auditDir, { recursive: true, force: true });
}

console.log(`cloudflared tarball audit passed: ${packageJson.name}@${packageJson.version}, ${list.length} entries`);
