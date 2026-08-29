#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

if (!process.argv[2]) throw new Error("usage: audit-cloudflared-tarball.mjs <package.tgz>");

const tarball = resolve(process.argv[2]);
const list = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
const packageJson = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/manifest.json"], { encoding: "utf8" }));

if (packageJson.name !== "agentroam-cloudflared-darwin-arm64") throw new Error(`unexpected package name: ${packageJson.name}`);
if (packageJson.version !== "0.2.0-preview.4") throw new Error(`unexpected package version: ${packageJson.version}`);
if (JSON.stringify(packageJson.os) !== JSON.stringify(["darwin"])) throw new Error(`unexpected package os: ${JSON.stringify(packageJson.os)}`);
if (JSON.stringify(packageJson.cpu) !== JSON.stringify(["arm64"])) throw new Error(`unexpected package cpu: ${JSON.stringify(packageJson.cpu)}`);
if (packageJson.exports?.["./archive"] !== "./vendor/cloudflared-darwin-arm64.tgz") throw new Error("cloudflared archive export missing");
if (packageJson.exports?.["./manifest.json"] !== "./manifest.json") throw new Error("cloudflared manifest export missing");
if (basename(tarball) !== `${packageJson.name}-${packageJson.version}.tgz`) throw new Error("cloudflared tarball filename mismatch");
if (statSync(tarball).size >= 30_000_000) throw new Error(`cloudflared package exceeds 30 MB release limit: ${statSync(tarball).size}`);
if (manifest.packageVersion !== "0.2.0-preview.4") throw new Error(`unexpected manifest package version: ${manifest.packageVersion}`);
if (manifest.upstreamVersion !== "2026.8.2") throw new Error(`unexpected cloudflared version: ${manifest.upstreamVersion}`);
if (manifest.target !== "darwin-arm64" || manifest.fileName !== "cloudflared") throw new Error("unexpected cloudflared manifest target");
if (manifest.size !== 19214189) throw new Error(`unexpected cloudflared archive size: ${manifest.size}`);
if (manifest.sha256 !== "9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442") {
  throw new Error(`unexpected cloudflared SHA-256: ${manifest.sha256}`);
}

const allowed = new Set([
  "package/package.json",
  "package/README.md",
  "package/manifest.json",
  "package/vendor/cloudflared-darwin-arm64.tgz",
]);
const unexpected = list.filter((file) => !allowed.has(file));
if (unexpected.length) throw new Error(`unexpected cloudflared package files:\n${unexpected.join("\n")}`);

const auditDir = mkdtempSync(join(tmpdir(), "agentroam-cloudflared-audit-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", auditDir, "package/vendor/cloudflared-darwin-arm64.tgz"]);
  const archive = join(auditDir, "package/vendor/cloudflared-darwin-arm64.tgz");
  const info = await stat(archive);
  const actualHash = await sha256File(archive);
  if (info.size !== manifest.size) throw new Error(`nested archive size mismatch: ${info.size}`);
  if (actualHash !== manifest.sha256) throw new Error(`nested archive SHA-256 mismatch: ${actualHash}`);
  const nested = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  if (nested.length !== 1 || nested[0].replace(/^\.\//, "") !== "cloudflared") {
    throw new Error(`unexpected upstream archive entries: ${nested.join(", ")}`);
  }
} finally {
  rmSync(auditDir, { recursive: true, force: true });
}

console.log(`cloudflared tarball audit passed: ${packageJson.name}@${packageJson.version}, ${list.length} entries`);

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}
